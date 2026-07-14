require('dotenv').config();
const { execSync } = require('child_process');
const express = require('express');
const fs = require('fs');
const path = require('path');

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

try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
  console.log('✓ FFmpeg available');
} catch {
  console.error('✗ CRITICAL: FFmpeg missing — video splitting will fail');
}

// Skip yt-dlp auto-update on Render to avoid GitHub rate limits.
console.log('Skipping yt-dlp auto-update.');

setupCookies();

// ─── Queue Slot (max 1 concurrent download) ───────────────────────────────────

let activeDownload = false;

const acquireSlot = () => {
  if (activeDownload) return false;
  activeDownload = true;
  return true;
};

const releaseSlot = () => {
  activeDownload = false;
};

// ─── Auth Middleware ──────────────────────────────────────────────────────────

const authMiddleware = (req, res, next) => {
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
  const { filename } = req.params;

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
  res.on('close',  () => cleanup(filePath)); // handles aborted requests too
});

// ─── Download Route ───────────────────────────────────────────────────────────

app.post('/download', async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ success: false, error: 'Please provide a valid video URL.' });
  }

  // Queue gate
  if (!acquireSlot()) {
    return res.status(429).json({
      success: false,
      error: 'PocketAssist is currently processing another download. Please wait a moment and try again.',
    });
  }

  const platform = detectPlatform(url);

  try {
    // Fetch description and download in parallel to save time
    console.log(`New download request: ${url}`);
    const [descriptionResult, downloadResult] = await Promise.allSettled([
      fetchDescription(url, platform),
      downloadVideo(url, platform),
    ]);

    // downloadVideo result — if it failed, throw
    if (downloadResult.status === 'rejected') throw downloadResult.reason;

    const { files, videoOnly } = downloadResult.value;
    const description = descriptionResult.status === 'fulfilled'
      ? descriptionResult.value
      : DEFAULT_DESCRIPTION;

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

    return res.json(response);

  } catch (error) {
    console.error('Download error:', error.message);

    // Duration exceeded — friendly message
    if (error.message === 'DURATION_EXCEEDED') {
      return res.status(400).json({ success: false, error: error.userMessage });
    }

    const stderrText = error.stderr || error.message || '';
    const userMessage =
      parseYtDlpError(stderrText) ||
      'Failed to download this video. The link may be unsupported or the video is unavailable.';

    return res.status(400).json({ success: false, error: userMessage });

  } finally {
    releaseSlot();
  }
});

// ─── Fallback Error Handlers ──────────────────────────────────────────────────

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
  console.log(`PocketAssist Downloader running on port ${PORT}`);
});