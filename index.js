require('dotenv').config();
const { spawn, execSync } = require('child_process');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const TEMP_DIR = path.join(__dirname, 'temp');
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'pocketassist-dl-secret';

const SAFE_LIMIT_MB = 10;
const MAX_PARTS = 5;

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Force update yt-dlp binary on startup
try {
  console.log('Updating yt-dlp binary...');
  execSync('node_modules/.bin/yt-dlp -U', { stdio: 'inherit', timeout: 60000 });
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
      // Facebook often only has a single merged stream; be very permissive
      opts.format = [
        'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]',
        'bestvideo[height<=720]+bestaudio',
        'best[height<=720][ext=mp4]',
        'best[height<=720]',
        'best',
      ].join('/');
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
    // Cookies are strongly recommended for Facebook — set them if available
    if (process.env.FACEBOOK_COOKIES) {
      opts.cookies = FB_COOKIES_PATH;
    }
    // Some FB URLs need this to resolve properly
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
  stream.on('end', () => cleanup(filePath));
  stream.on('error', () => cleanup(filePath));
});

// ─── Main download endpoint ───────────────────────────────────────────────────

app.post('/download', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const trimmedUrl = url.trim();
  const isInstagram = trimmedUrl.includes('instagram.com');
  const isYouTube = trimmedUrl.includes('youtube.com') || trimmedUrl.includes('youtu.be');
  const isFacebook = trimmedUrl.includes('facebook.com') || trimmedUrl.includes('fb.watch') || trimmedUrl.includes('fb.com');

  let outputPath = null;
  let compressedPath = null;

  try {
    const ytDlp = require('yt-dlp-exec');

    // ── Step 1: fetch video info ───────────────────────────────────────────
    let videoInfo;
    try {
      const infoOpts = buildYtDlpOptions(trimmedUrl, isYouTube, isInstagram, isFacebook, true, null);
      videoInfo = await ytDlp(trimmedUrl, infoOpts);
    } catch (infoErr) {
      const stderr = infoErr.stderr || infoErr.message || '';
      console.error('[yt-dlp info error]', stderr.slice(-2000));

      const friendly = parseYtDlpError(stderr, trimmedUrl);
      return res.status(400).json({
        error: friendly || 'Could not fetch video info — the link may be invalid, private, or unsupported.',
      });
    }

    const durationSeconds = videoInfo?.duration || 0;

    if (durationSeconds > 600) {
      const mins = Math.floor(durationSeconds / 60);
      return res.status(400).json({ error: `Video is ${mins} min long — maximum is 10 minutes.` });
    }

    // ── Step 2: build caption ─────────────────────────────────────────────
    const videoTitle = (videoInfo?.title || '').trim();
    const videoDescription = (videoInfo?.description || '').trim();
    const cleanDescription = videoDescription.replace(/https?:\/\/\S+/g, '').trim();
    let captionText = '';
    if (cleanDescription) {
      captionText = cleanDescription.substring(0, 800) + (cleanDescription.length > 800 ? '...' : '');
    } else if (videoTitle) {
      captionText = videoTitle.substring(0, 100);
    }

    // ── Step 3: download ──────────────────────────────────────────────────
    outputPath = path.join(TEMP_DIR, `${uuidv4()}.mp4`);
    const dlOpts = buildYtDlpOptions(trimmedUrl, isYouTube, isInstagram, isFacebook, false, outputPath);

    try {
      await ytDlp(trimmedUrl, dlOpts);
    } catch (dlErr) {
      const stderr = dlErr.stderr || dlErr.message || '';
      console.error('[yt-dlp download error]', stderr.slice(-2000));

      // Facebook-specific retry: if the first attempt failed, try with a
      // more permissive format string in case the stream requires re-muxing
      if (isFacebook) {
        console.log('[Facebook] Retrying with fallback format...');
        try {
          const fallbackOpts = { ...dlOpts, format: 'best/bestvideo+bestaudio' };
          await ytDlp(trimmedUrl, fallbackOpts);
        } catch (retryErr) {
          const retryStderr = retryErr.stderr || retryErr.message || '';
          console.error('[Facebook fallback error]', retryStderr.slice(-1000));
          const friendly = parseYtDlpError(retryStderr, trimmedUrl)
            || parseYtDlpError(stderr, trimmedUrl);
          return res.status(400).json({
            error: friendly || 'Facebook video download failed. If this is a private or login-required video, add FACEBOOK_COOKIES to your environment.',
          });
        }
      } else {
        const friendly = parseYtDlpError(stderr, trimmedUrl);
        return res.status(400).json({
          error: friendly || 'Download failed — the video could not be retrieved.',
        });
      }
    }

    // Verify the file actually exists and has content
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      return res.status(500).json({ error: 'Download failed — file was not created. The video format may be unsupported.' });
    }

    const stats = fs.statSync(outputPath);
    const fileSizeMB = stats.size / (1024 * 1024);

    let candidatePath = outputPath;
    let candidateSizeMB = fileSizeMB;

    // ── Step 4: compress if needed ────────────────────────────────────────
    if (fileSizeMB > SAFE_LIMIT_MB) {
      compressedPath = path.join(TEMP_DIR, `${uuidv4()}_compressed.mp4`);
      const dynamicTimeoutMs = 90000 + Math.ceil((durationSeconds / 60) * 15000);

      try {
        await new Promise((resolve, reject) => {
          let finished = false;
          let scaleHeight, crf;

          if (durationSeconds <= 60) {
            scaleHeight = 720; crf = 20;
          } else if (durationSeconds <= 120) {
            scaleHeight = 720; crf = 23;
          } else if (durationSeconds <= 300) {
            scaleHeight = 480; crf = 23;
          } else {
            scaleHeight = 480; crf = 26;
          }

          const ffmpegCommand = ffmpeg(outputPath)
            .outputOptions([
              '-vcodec libx264',
              `-crf ${crf}`,
              '-preset fast',
              `-vf scale=-2:${scaleHeight}`,
              '-acodec aac',
              '-b:a 96k',
            ])
            .output(compressedPath)
            .on('end', () => { finished = true; resolve(); })
            .on('error', (err) => { finished = true; reject(err); });

          const timeoutHandle = setTimeout(() => {
            if (!finished) {
              finished = true;
              try { ffmpegCommand.kill('SIGKILL'); } catch (_) {}
              reject(new Error('COMPRESSION_TIMEOUT'));
            }
          }, dynamicTimeoutMs);

          ffmpegCommand.on('end', () => clearTimeout(timeoutHandle));
          ffmpegCommand.on('error', () => clearTimeout(timeoutHandle));
          ffmpegCommand.run();
        });

        if (fs.existsSync(compressedPath) && fs.statSync(compressedPath).size > 0) {
          candidatePath = compressedPath;
          candidateSizeMB = fs.statSync(compressedPath).size / (1024 * 1024);
        }
      } catch (compressErr) {
        console.error('Compression skipped:', compressErr.message);
        cleanup(compressedPath);
        compressedPath = null;
        candidatePath = outputPath;
        candidateSizeMB = fileSizeMB;
      }
    }

    // ── Step 5: send directly or split ───────────────────────────────────
    if (candidateSizeMB <= SAFE_LIMIT_MB) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('X-Caption', encodeURIComponent(captionText));
      res.setHeader('X-Duration', durationSeconds);
      const fileStream = fs.createReadStream(candidatePath);
      fileStream.pipe(res);
      fileStream.on('end', () => {
        cleanup(outputPath);
        cleanup(compressedPath);
      });
      fileStream.on('error', (streamErr) => {
        console.error('Stream error:', streamErr.message);
        cleanup(outputPath);
        cleanup(compressedPath);
      });
      return;
    }

    // Still too big — split by time
    const safeDuration = durationSeconds || 60;
    const bytesPerSecond = (candidateSizeMB * 1024 * 1024) / safeDuration;
    let segmentSeconds = Math.floor((SAFE_LIMIT_MB * 1024 * 1024) / bytesPerSecond);
    if (segmentSeconds < 1) segmentSeconds = 1;

    let parts = Math.ceil(safeDuration / segmentSeconds);
    if (parts > MAX_PARTS) {
      segmentSeconds = Math.ceil(safeDuration / MAX_PARTS);
      parts = MAX_PARTS;
    }

    let baseId;
    try {
      baseId = await splitVideo(candidatePath, segmentSeconds);
    } catch (splitErr) {
      console.error('Split failed:', splitErr.message);
      cleanup(outputPath);
      cleanup(compressedPath);
      return res.status(400).json({ error: 'Video is too large to send even after splitting — please try a shorter clip.' });
    }

    const partFiles = fs.readdirSync(TEMP_DIR)
      .filter((f) => f.startsWith(baseId))
      .sort();

    if (partFiles.length === 0) {
      cleanup(outputPath);
      cleanup(compressedPath);
      return res.status(500).json({ error: 'Split produced no output files.' });
    }

    const oversizedPart = partFiles.find((f) => {
      const sizeMB = fs.statSync(path.join(TEMP_DIR, f)).size / (1024 * 1024);
      return sizeMB > 15;
    });

    if (oversizedPart) {
      partFiles.forEach((f) => cleanup(path.join(TEMP_DIR, f)));
      cleanup(outputPath);
      cleanup(compressedPath);
      return res.status(400).json({ error: 'Video is too dense to split cleanly — try a shorter or lower-quality clip.' });
    }

    cleanup(outputPath);
    cleanup(compressedPath);

    return res.json({
      split: true,
      caption: captionText,
      duration: durationSeconds,
      parts: partFiles.length,
      files: partFiles,
    });

  } catch (err) {
    // Catch-all — this should never be reached under normal conditions but
    // prevents the server from crashing silently and leaving the client hanging.
    console.error('[Downloader unhandled error]', err.message);
    console.error(err.stack);

    cleanup(outputPath);
    cleanup(compressedPath);

    // Only send a response if the headers haven't been flushed yet
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Download failed — an unexpected error occurred. Please try again.' });
    }
  }
});

// ─── Periodic temp file sweep ─────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const MAX_FILE_AGE_MS = 2 * 60 * 60 * 1000;

setInterval(() => {
  try {
    const now = Date.now();
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > MAX_FILE_AGE_MS) {
          fs.unlinkSync(filePath);
          console.log('Swept stale temp file:', file);
        }
      } catch (_) {}
    }
  } catch (e) {
    console.error('Sweep error:', e.message);
  }
}, SWEEP_INTERVAL_MS);

// ─── Global uncaught error handlers — prevent silent crashes ─────────────────

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message);
  console.error(err.stack);
  // Do NOT exit — keep the server alive
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
  // Do NOT exit — keep the server alive
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 PocketAssist Downloader running on port ${PORT}`);
});