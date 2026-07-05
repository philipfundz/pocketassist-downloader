require('dotenv').config();
const { spawn, execSync } = require('child_process');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ytDlp = require('yt-dlp-exec');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const TEMP_DIR = path.join(__dirname, 'temp');
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'pocketassist-dl-secret';

const SAFE_LIMIT_MB = 10;
const MAX_PARTS = 5;

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Check for system FFmpeg dependency on boot
try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
  console.log('FFmpeg is installed and accessible');
} catch (e) {
  console.error('CRITICAL WARNING: FFmpeg is missing or inaccessible! Video merging and splitting will fail.');
}

// Force update yt-dlp binary on startup
try {
  console.log('Updating yt-dlp binary...');
  execSync('node_modules/yt-dlp-exec/bin/yt-dlp -U', { stdio: 'inherit', timeout: 60000 });
  console.log('yt-dlp update complete');
} catch (e) {
  console.log('yt-dlp update skipped:', e.message);
}

// ─── Cookie setup ─────────────────────────────────────────────────────────────

const YT_COOKIES_PATH = '/tmp/yt_cookies.txt';
if (process.env.YOUTUBE_COOKIES) {
  try {
    fs.writeFileSync(YT_COOKIES_PATH, process.env.YOUTUBE_COOKIES);
    console.log('YouTube cookies written to', YT_COOKIES_PATH);
  } catch (e) {
    console.error('Failed to write YouTube cookies:', e.message);
  }
}

const IG_COOKIES_PATH = '/tmp/ig_cookies.txt';
if (process.env.INSTAGRAM_COOKIES) {
  try {
    fs.writeFileSync(IG_COOKIES_PATH, process.env.INSTAGRAM_COOKIES);
    console.log('Instagram cookies written to', IG_COOKIES_PATH);
  } catch (e) {
    console.error('Failed to write Instagram cookies:', e.message);
  }
}

const FB_COOKIES_PATH = '/tmp/fb_cookies.txt';
if (process.env.FACEBOOK_COOKIES) {
  try {
    fs.writeFileSync(FB_COOKIES_PATH, process.env.FACEBOOK_COOKIES);
    console.log('Facebook cookies written to', FB_COOKIES_PATH);
  } catch (e) {
    console.error('Failed to write Facebook cookies:', e.message);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const cleanup = (filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
};

// Parse a human-readable yt-dlp error into a clean user-facing message
const parseYtDlpError = (stderr = '', url = '') => {
  if (!stderr) return null;

  if (stderr.includes('Video unavailable') || stderr.includes('This video is not available'))
    return 'This video is unavailable or has been removed.';

  if (stderr.includes('Private video') || stderr.includes('private'))
    return 'This video is private — it cannot be downloaded.';

  if (stderr.includes('age') && stderr.includes('confirm'))
    return 'This video requires age verification and cannot be downloaded without cookies.';

  if (stderr.includes('login') || stderr.includes('Login') || stderr.includes('sign in'))
    return 'This video requires a login to access. Try adding Facebook cookies in your .env file.';

  if (stderr.includes('Unsupported URL') || stderr.includes('[generic]'))
    return "That doesn't look like a supported video link — please share the direct link to the video, not a profile or homepage.";

  if (stderr.includes('429') || stderr.includes('Too Many Requests'))
    return 'The platform is rate-limiting downloads right now. Please try again in a few minutes.';

  if (stderr.includes('HTTP Error 403') || stderr.includes('403'))
    return 'Access denied by the platform. This video may require cookies to download.';

  if (stderr.includes('HTTP Error 404') || stderr.includes('404'))
    return 'Video not found — the link may be broken or the video was deleted.';

  if (stderr.includes('Unable to extract') || stderr.includes('Could not find'))
    return 'Could not extract video info — the link format may not be supported.';

  return null;
};

// Build yt-dlp options for a given platform
const buildYtDlpOptions = (url, isYouTube, isInstagram, isFacebook, isInfoOnly, outputPath) => {
  const opts = {
    noPlaylist: true,
    noCheckCertificates: true,
  };

  if (isInfoOnly) {
    opts.dumpSingleJson = true;
    opts.skipDownload = true;
  } else {
    opts.output = outputPath;
    opts.mergeOutputFormat = 'mp4';

    // Format selection — ordered from most to least preferred
    if (isFacebook) {
      // Drop strict [ext=m4a] — Facebook audio is AAC in non-standard containers
      opts.format = 'bestvideo[height<=720]+bestaudio/best[height<=720]/best';
    } else if (isYouTube) {
      opts.format = [
        'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]',
        'best[height<=720][ext=mp4]',
        'best[height<=480]',
        'worst',
      ].join('/');
    } else {
      opts.format = [
        'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]',
        'best[height<=720][ext=mp4]',
        'best[height<=480]',
        'best',
      ].join('/');
    }
  }

  if (isYouTube) {
    opts.extractorArgs = 'youtube:player_client=web';
    if (process.env.YOUTUBE_COOKIES) opts.cookies = YT_COOKIES_PATH;
  }

  if (isInstagram) {
    opts.addHeader = [
      'referer:https://www.instagram.com/',
      'x-ig-app-id:936619743392459',
    ];
    opts.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    if (process.env.INSTAGRAM_COOKIES) opts.cookies = IG_COOKIES_PATH;
  }

  if (isFacebook) {
    opts.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    if (process.env.FACEBOOK_COOKIES) opts.cookies = FB_COOKIES_PATH;
    opts.addHeader = [
      'referer:https://www.facebook.com/',
    ];
  }

  return opts;
};

// ─── Video splitter ───────────────────────────────────────────────────────────

function splitVideo(inputPath, segmentSeconds) {
  return new Promise((resolve, reject) => {
    const baseId = uuidv4();
    const pattern = path.join(TEMP_DIR, `${baseId}_part%03d.mp4`);

    const args = [
      '-i', inputPath,
      '-c', 'copy',
      '-map', '0',
      '-f', 'segment',
      '-segment_time', `${segmentSeconds}`,
      '-reset_timestamps', '1',
      pattern,
    ];

    const proc = spawn('ffmpeg', args);
    let stderr = '';
    let finished = false;

    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timeoutHandle = setTimeout(() => {
      if (!finished) {
        finished = true;
        proc.kill('SIGKILL');
        reject(new Error('SPLIT_TIMEOUT'));
      }
    }, 60000);

    proc.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      if (code === 0) {
        resolve(baseId);
      } else {
        console.error('ffmpeg split stderr:', stderr.slice(-1000));
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      reject(err);
    });
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check — public
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pocketassist-downloader' });
});

// Auth middleware
app.use((req, res, next) => {
  const token = req.headers['x-auth-token'];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Serve a single split part, then delete it
app.get('/file/:filename', (req, res) => {
  const filename = req.params.filename;
  if (filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(TEMP_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found or already served' });
  }
  res.setHeader('Content-Type', 'video/mp4');

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);

  res.on('finish', () => {
    cleanup(filePath);
  });
});

// ─── Download Route ───────────────────────────────────────────────────────────

app.post('/download', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'Please provide a valid video URL.' });
  }

  const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
  const isInstagram = url.includes('instagram.com');
  const isFacebook = url.includes('facebook.com') || url.includes('fb.watch');

  const fileId = uuidv4();
  const outputPath = path.join(TEMP_DIR, `${fileId}.mp4`);

  const opts = buildYtDlpOptions(url, isYouTube, isInstagram, isFacebook, false, outputPath);

  // Build args array for raw spawn (gives us full stderr logging)
  const ytDlpBin = path.join(__dirname, 'node_modules/yt-dlp-exec/bin/yt-dlp');
  const args = [url];

  if (opts.format) args.push('-f', opts.format);
  args.push('-o', opts.output);
  args.push('--merge-output-format', 'mp4');
  if (opts.cookies) args.push('--cookies', opts.cookies);
  args.push('--no-playlist');
  args.push('--no-check-certificates');
  if (opts.extractorArgs) args.push('--extractor-args', opts.extractorArgs);
  if (opts.userAgent) args.push('--user-agent', opts.userAgent);
  if (opts.addHeader) {
    for (const h of opts.addHeader) args.push('--add-header', h);
  }

  console.log(`Starting download for URL: ${url}`);
  console.log(`yt-dlp args: ${args.join(' ')}`);

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(ytDlpBin, args);
      let stderr = '';
      let finished = false;

      proc.stdout.on('data', (d) => process.stdout.write(d));
      proc.stderr.on('data', (d) => {
        const chunk = d.toString();
        stderr += chunk;
        process.stderr.write(chunk); // stream to Render logs in real time
      });

      const timeoutHandle = setTimeout(() => {
        if (!finished) {
          finished = true;
          proc.kill('SIGKILL');
          reject(Object.assign(new Error('DOWNLOAD_TIMEOUT'), { stderr }));
        }
      }, 120000); // 2 min timeout

      proc.on('close', (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutHandle);
        if (code === 0) {
          resolve();
        } else {
          reject(Object.assign(new Error(`yt-dlp exited with code ${code}`), { stderr }));
        }
      });

      proc.on('error', (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutHandle);
        err.stderr = stderr;
        reject(err);
      });
    });

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ success: false, error: 'Video file processing failed.' });
    }

    const stats = fs.statSync(outputPath);
    const fileSizeInMB = stats.size / (1024 * 1024);
    console.log(`Download complete. File size: ${fileSizeInMB.toFixed(2)}MB`);

    // Small file — return as single part
    if (fileSizeInMB <= SAFE_LIMIT_MB) {
      return res.json({
        success: true,
        split: false,
        files: [`/file/${fileId}.mp4`],
      });
    }

    // Large file — split into segments via FFmpeg
    console.log(`File exceeds ${SAFE_LIMIT_MB}MB limit. Splitting...`);
    const segmentSeconds = 60;
    const baseSplitId = await splitVideo(outputPath, segmentSeconds);
    cleanup(outputPath);

    const files = fs.readdirSync(TEMP_DIR)
      .filter(f => f.startsWith(baseSplitId) && f.endsWith('.mp4'))
      .sort()
      .slice(0, MAX_PARTS)
      .map(f => `/file/${f}`);

    if (files.length === 0) {
      return res.status(500).json({ success: false, error: 'Video splitting failed to generate parts.' });
    }

    return res.json({ success: true, split: true, files });

  } catch (error) {
    console.error('Download failed:', error.message);
    cleanup(outputPath);
    const stderrText = error.stderr || error.message || '';
    const userMessage = parseYtDlpError(stderrText, url) || 'Failed to download this video. Please try again.';
    return res.status(400).json({ success: false, error: userMessage });
  }
});

// ─── Error Handling ───────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found.' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err.stack);
  res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Downloader microservice running on port ${PORT}`);
});