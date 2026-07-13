require('dotenv').config();
const { execSync } = require('child_process');
const express = require('express');
const fs = require('fs');
const path = require('path');
<<<<<<< HEAD
const { v4: uuidv4 } = require('uuid');
=======
>>>>>>> 84b877c (rebuild: modular downloader with description, FB fallback, duration check, queue)

const {
  setupCookies,
  detectPlatform,
  cleanup,
  cleanupDir,
  parseYtDlpError,
  DEFAULT_DESCRIPTION,
} = require('./helpers');
const { downloadVideo } = require('./downloader');
const { fetchDescription } = require('./metadata');

const app  = express();
app.use(express.json());

const PORT       = process.env.PORT || 3001;
const TEMP_DIR   = path.join(__dirname, 'temp');
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'pocketassist-dl-secret';

// ─── Boot Checks ──────────────────────────────────────────────────────────────

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

<<<<<<< HEAD
// ─── FFmpeg check ─────────────────────────────────────────────────────────────

=======
>>>>>>> 84b877c (rebuild: modular downloader with description, FB fallback, duration check, queue)
try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
  console.log('✓ FFmpeg available');
} catch {
  console.error('✗ CRITICAL: FFmpeg missing — video splitting will fail');
}

<<<<<<< HEAD
// ─── yt-dlp binary setup ──────────────────────────────────────────────────────
// Copy binary to /tmp so it can self-update — node_modules is read-only on Render

const YTDLP_SOURCE = path.join(__dirname, 'node_modules/yt-dlp-exec/bin/yt-dlp');
const YTDLP_BIN = '/tmp/yt-dlp';

try {
  fs.copyFileSync(YTDLP_SOURCE, YTDLP_BIN);
  fs.chmodSync(YTDLP_BIN, '755');
  console.log('yt-dlp binary copied to /tmp');
} catch (e) {
  console.warn('Could not copy yt-dlp to /tmp, falling back to source binary:', e.message);
}

const ytDlpBin = fs.existsSync(YTDLP_BIN) ? YTDLP_BIN : YTDLP_SOURCE;

// Update the writable copy on every cold start
try {
  console.log('Updating yt-dlp binary...');
  execSync(`${ytDlpBin} -U`, { stdio: 'inherit', timeout: 60000 });
  console.log('yt-dlp update complete');
=======
try {
  console.log('Updating yt-dlp binary...');
  execSync('node_modules/yt-dlp-exec/bin/yt-dlp -U', { stdio: 'inherit', timeout: 60000 });
  console.log('✓ yt-dlp updated');
>>>>>>> 84b877c (rebuild: modular downloader with description, FB fallback, duration check, queue)
} catch (e) {
  console.log('yt-dlp update skipped:', e.message);
}

setupCookies();

// ─── Queue Slot (max 1 concurrent download) ───────────────────────────────────

let activeDownload = false;

const acquireSlot = () => {
  if (activeDownload) return false;
  activeDownload = true;
  return true;
};

<<<<<<< HEAD
const parseYtDlpError = (stderr = '') => {
  if (!stderr) return null;

  if (stderr.includes('Video unavailable') || stderr.includes('This video is not available'))
    return 'This video is unavailable or has been removed.';

  if (stderr.includes('Private video') || stderr.includes('private'))
    return 'This video is private — it cannot be downloaded.';

  if (stderr.includes('age') && stderr.includes('confirm'))
    return 'This video requires age verification and cannot be downloaded without cookies.';

  if (stderr.includes('login') || stderr.includes('Login') || stderr.includes('sign in'))
    return 'This video requires a login to access. Please make sure cookies are set in your environment.';

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

// ─── yt-dlp option builder ────────────────────────────────────────────────────

const buildYtDlpArgs = (url, isYouTube, isInstagram, isFacebook, outputPath) => {
  const args = [url];

  // ── Format selection ──
  if (isFacebook) {
    args.push('-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]/best');
  } else if (isYouTube) {
    args.push('-f', [
      'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]',
      'best[height<=720][ext=mp4]',
      'best[height<=480]',
      'worst',
    ].join('/'));
  } else {
    args.push('-f', [
      'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]',
      'best[height<=720][ext=mp4]',
      'best[height<=480]',
      'best',
    ].join('/'));
  }

  args.push('-o', outputPath);
  args.push('--merge-output-format', 'mp4');
  args.push('--no-playlist');
  args.push('--no-check-certificates');

  // ── Platform-specific options ──
  if (isYouTube) {
    args.push('--extractor-args', 'youtube:player_client=web');
    if (process.env.YOUTUBE_COOKIES) args.push('--cookies', YT_COOKIES_PATH);
  }

  if (isInstagram) {
    args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36');
    args.push('--add-header', 'referer:https://www.instagram.com/');
    args.push('--add-header', 'x-ig-app-id:936619743392459');
    if (process.env.INSTAGRAM_COOKIES) args.push('--cookies', IG_COOKIES_PATH);
  }

  if (isFacebook) {
    // Updated Chrome user agent — Facebook blocks outdated agents
    args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36');
    args.push('--add-header', 'referer:https://www.facebook.com/');
    args.push('--add-header', 'accept-language:en-US,en;q=0.9');
    args.push('--socket-timeout', '30');
    args.push('--geo-bypass');
    if (process.env.FACEBOOK_COOKIES) args.push('--cookies', FB_COOKIES_PATH);
  }

  return args;
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

// Health check — public, no auth required
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pocketassist-downloader' });
});

// Auth middleware — all routes below require token
app.use((req, res, next) => {
=======
const releaseSlot = () => {
  activeDownload = false;
};

// ─── Auth Middleware ──────────────────────────────────────────────────────────

const authMiddleware = (req, res, next) => {
>>>>>>> 84b877c (rebuild: modular downloader with description, FB fallback, duration check, queue)
  const token = req.headers['x-auth-token'];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ─── Public Routes ────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'pocketassist-downloader',
    busy: activeDownload,
  });
});

// ─── Protected Routes ─────────────────────────────────────────────────────────

app.use(authMiddleware);

// Serve a split part then delete it
app.get('/file/:filename', (req, res) => {
<<<<<<< HEAD
  const filename = req.params.filename;
=======
  const { filename } = req.params;
>>>>>>> 84b877c (rebuild: modular downloader with description, FB fallback, duration check, queue)

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

  res.on('finish', () => cleanup(filePath));
<<<<<<< HEAD
=======
  res.on('close',  () => cleanup(filePath)); // handles aborted requests too
>>>>>>> 84b877c (rebuild: modular downloader with description, FB fallback, duration check, queue)
});

// ─── Download route ───────────────────────────────────────────────────────────

app.post('/download', async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ success: false, error: 'Please provide a valid video URL.' });
  }

<<<<<<< HEAD
  const isYouTube  = url.includes('youtube.com') || url.includes('youtu.be');
  const isInstagram = url.includes('instagram.com');
  const isFacebook  = url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.com/');

  const fileId = uuidv4();
  const outputPath = path.join(TEMP_DIR, `${fileId}.mp4`);

  const args = buildYtDlpArgs(url, isYouTube, isInstagram, isFacebook, outputPath);

  console.log(`Starting download for: ${url}`);
  console.log(`yt-dlp args: ${args.join(' ')}`);
=======
  // Queue gate
  if (!acquireSlot()) {
    return res.status(429).json({
      success: false,
      error: 'PocketAssist is currently processing another download. Please wait a moment and try again.',
    });
  }

  const platform = detectPlatform(url);
>>>>>>> 84b877c (rebuild: modular downloader with description, FB fallback, duration check, queue)

  try {
    // Fetch description and download in parallel to save time
    console.log(`New download request: ${url}`);
    const [descriptionResult, downloadResult] = await Promise.allSettled([
      fetchDescription(url, platform),
      downloadVideo(url, platform),
    ]);

<<<<<<< HEAD
      proc.stdout.on('data', (d) => process.stdout.write(d));
      proc.stderr.on('data', (d) => {
        const chunk = d.toString();
        stderr += chunk;
        process.stderr.write(chunk);
      });

      const timeoutHandle = setTimeout(() => {
        if (!finished) {
          finished = true;
          proc.kill('SIGKILL');
          reject(Object.assign(new Error('DOWNLOAD_TIMEOUT'), { stderr }));
        }
      }, 120000); // 2 min hard timeout
=======
    // downloadVideo result — if it failed, throw
    if (downloadResult.status === 'rejected') throw downloadResult.reason;

    const { files, videoOnly } = downloadResult.value;
    const description = descriptionResult.status === 'fulfilled'
      ? descriptionResult.value
      : DEFAULT_DESCRIPTION;
>>>>>>> 84b877c (rebuild: modular downloader with description, FB fallback, duration check, queue)

    // Build response — description only on the first file
    const response = {
      success: true,
      split: files.length > 1,
      videoOnly,              // true = Facebook audio was DRM-blocked, video-only served
      files: files.map((fileUrl, index) => ({
        url: fileUrl,
        part: index + 1,
        total: files.length,
        ...(index === 0 && { description }), // description only on part 1
      })),
    };

<<<<<<< HEAD
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
    console.log(`File exceeds ${SAFE_LIMIT_MB}MB. Splitting into segments...`);
    const baseSplitId = await splitVideo(outputPath, 60);
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
=======
    return res.json(response);
>>>>>>> 84b877c (rebuild: modular downloader with description, FB fallback, duration check, queue)

  } catch (error) {
    console.error('Download error:', error.message);

    // Duration exceeded — friendly message
    if (error.message === 'DURATION_EXCEEDED') {
      return res.status(400).json({ success: false, error: error.userMessage });
    }

    const stderrText = error.stderr || error.message || '';
<<<<<<< HEAD
    const userMessage = parseYtDlpError(stderrText) || 'Failed to download this video. Please try again.';
=======
    const userMessage =
      parseYtDlpError(stderrText) ||
      'Failed to download this video. The link may be unsupported or the video is unavailable.';

>>>>>>> 84b877c (rebuild: modular downloader with description, FB fallback, duration check, queue)
    return res.status(400).json({ success: false, error: userMessage });

  } finally {
    releaseSlot();
  }
});

<<<<<<< HEAD
// ─── Error handlers ───────────────────────────────────────────────────────────
=======
// ─── Fallback Error Handlers ──────────────────────────────────────────────────
>>>>>>> 84b877c (rebuild: modular downloader with description, FB fallback, duration check, queue)

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found.' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err.stack);
  releaseSlot(); // safety release in case of catastrophic error
  res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
});

// ─── Temp Cleanup on Boot ─────────────────────────────────────────────────────
// Clear any leftover files from a previous crash

try {
  const leftover = fs.readdirSync(TEMP_DIR);
  if (leftover.length > 0) {
    console.log(`Cleaning ${leftover.length} leftover temp file(s) from previous run...`);
    leftover.forEach(f => cleanup(path.join(TEMP_DIR, f)));
  }
} catch (e) {
  console.warn('Could not clean temp dir on boot:', e.message);
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
<<<<<<< HEAD
  console.log(`PocketAssist downloader microservice running on port ${PORT}`);
});
  
=======
  console.log(`PocketAssist Downloader running on port ${PORT}`);
});
>>>>>>> 84b877c (rebuild: modular downloader with description, FB fallback, duration check, queue)
