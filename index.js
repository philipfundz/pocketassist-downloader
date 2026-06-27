require('dotenv').config();
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

const SAFE_LIMIT_MB = 14;
const MAX_PARTS = 5;

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

const cleanup = (filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
};

// Health check — public, no auth (UptimeRobot can't send custom headers)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pocketassist-downloader' });
});

// TEMP DEBUG ROUTE — remove after diagnosing yt-dlp version issue
app.get('/debug/ytdlp-version', async (req, res) => {
  try {
    const ytDlp = require('yt-dlp-exec');
    const version = await ytDlp('--version');
    res.json({ version });
  } catch (e) {
    res.status(500).json({ error: e.message, stderr: e.stderr || null });
  }
});

// Auth middleware — applies to everything below this line
app.use((req, res, next) => {
  const token = req.headers['x-auth-token'];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Serve a single split part, then delete it
app.get('/file/:filename', (req, res) => {
  const filename = req.params.filename;
  // prevent path traversal
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

// Split a video by byte size, returns the shared baseId used in output filenames
function splitVideo(inputPath, segmentSizeBytes) {
  return new Promise((resolve, reject) => {
    const baseId = uuidv4();
    const pattern = path.join(TEMP_DIR, `${baseId}_part%03d.mp4`);
    let finished = false;

    const cmd = ffmpeg(inputPath)
      .outputOptions([
        '-f', 'segment',
        '-segment_size', `${segmentSizeBytes}`,
        '-reset_timestamps', '1',
        '-c', 'copy',
      ])
      .output(pattern)
      .on('end', () => {
        finished = true;
        resolve(baseId);
      })
      .on('error', (err) => {
        finished = true;
        reject(err);
      });

    const timeoutHandle = setTimeout(() => {
      if (!finished) {
        try { cmd.kill('SIGKILL'); } catch (e) {}
        reject(new Error('SPLIT_TIMEOUT'));
      }
    }, 60000);

    cmd.on('end', () => clearTimeout(timeoutHandle));
    cmd.on('error', () => clearTimeout(timeoutHandle));
    cmd.run();
  });
}

// Main download endpoint
app.post('/download', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let outputPath, compressedPath;

  try {
    const ytDlp = require('yt-dlp-exec');

    // Pre-download duration check
    let videoInfo;
    try {
      videoInfo = await ytDlp(url.trim(), {
        dumpSingleJson: true,
        noPlaylist: true,
        noCheckCertificates: true,
        skipDownload: true,
      });
    } catch (infoErr) {
      console.error('yt-dlp info fetch failed:', infoErr.message || infoErr);
      if (infoErr.stderr) console.error('yt-dlp stderr:', infoErr.stderr);

      const stderr = infoErr.stderr || '';
      if (stderr.includes('Unsupported URL') || stderr.includes('[generic]')) {
        return res.status(400).json({ error: 'That doesn\'t look like a video link — please share the direct link to the video, not a profile or homepage link.' });
      }

      return res.status(400).json({ error: 'Could not fetch video info — link may be invalid or unsupported' });
    }

    const durationSeconds = videoInfo?.duration || 0;

    if (durationSeconds > 600) {
      const mins = Math.floor(durationSeconds / 60);
      return res.status(400).json({ error: `Video is ${mins} min long — maximum is 10 minutes` });
    }

    // Extract caption
    const videoTitle = (videoInfo?.title || '').trim();
    const videoDescription = (videoInfo?.description || '').trim();
    const cleanDescription = videoDescription.replace(/https:\/\/t\.co\/\S+/g, '').trim();
    let captionText = '';
    if (cleanDescription) {
      captionText = cleanDescription.substring(0, 800) + (cleanDescription.length > 800 ? '...' : '');
    } else if (videoTitle) {
      captionText = videoTitle.substring(0, 100);
    }

    // Download
    outputPath = path.join(TEMP_DIR, `${uuidv4()}.mp4`);
    await ytDlp(url.trim(), {
      output: outputPath,
      format: 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=480]/worst',
      mergeOutputFormat: 'mp4',
      noPlaylist: true,
      noCheckCertificates: true,
    });

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Download failed — file not created' });
    }

    const stats = fs.statSync(outputPath);
    const fileSizeMB = stats.size / (1024 * 1024);

    // Decide candidate: original (if small) or attempt compression
    let candidatePath = outputPath;
    let candidateSizeMB = fileSizeMB;

    if (fileSizeMB > 10) {
      compressedPath = path.join(TEMP_DIR, `${uuidv4()}_compressed.mp4`);
      const dynamicTimeoutMs = 90000 + Math.ceil((durationSeconds / 60) * 15000);

      try {
        await new Promise((resolve, reject) => {
          let finished = false;
          // Tiered quality: shorter clips keep more sharpness, longer clips compress harder
          let scaleHeight, crf;
          if (durationSeconds <= 60) {
            scaleHeight = 720; crf = 23;
          } else if (durationSeconds <= 180) {
            scaleHeight = 480; crf = 25;
          } else {
            scaleHeight = 480; crf = 28;
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
              try { ffmpegCommand.kill('SIGKILL'); } catch (e) {}
              reject(new Error('COMPRESSION_TIMEOUT'));
            }
          }, dynamicTimeoutMs);

          ffmpegCommand.on('end', () => clearTimeout(timeoutHandle));
          ffmpegCommand.on('error', () => clearTimeout(timeoutHandle));
          ffmpegCommand.run();
        });

        if (fs.existsSync(compressedPath)) {
          candidatePath = compressedPath;
          candidateSizeMB = fs.statSync(compressedPath).size / (1024 * 1024);
        }
      } catch (compressErr) {
        // Compression failed or timed out — fall back silently to original file, no error to user
        console.error('Compression skipped:', compressErr.message);
        cleanup(compressedPath);
        compressedPath = null;
        candidatePath = outputPath;
        candidateSizeMB = fileSizeMB;
      }
    }

    // Case 1: fits in one file — send directly
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
      fileStream.on('error', () => {
        cleanup(outputPath);
        cleanup(compressedPath);
      });
      return;
    }

    // Case 2: still too big — split into parts
    const parts = Math.min(MAX_PARTS, Math.ceil(candidateSizeMB / SAFE_LIMIT_MB));
    const segmentSizeBytes = Math.ceil((candidateSizeMB * 1024 * 1024) / parts);

    let baseId;
    try {
      baseId = await splitVideo(candidatePath, segmentSizeBytes);
    } catch (splitErr) {
      console.error('Split failed:', splitErr.message);
      cleanup(outputPath);
      cleanup(compressedPath);
      return res.status(400).json({ error: 'Video too large to send even after splitting — try a shorter clip' });
    }

    const partFiles = fs.readdirSync(TEMP_DIR)
      .filter((f) => f.startsWith(baseId))
      .sort();

    cleanup(outputPath);
    cleanup(compressedPath);

    if (partFiles.length === 0) {
      return res.status(500).json({ error: 'Split produced no files' });
    }

    return res.json({
      split: true,
      caption: captionText,
      duration: durationSeconds,
      parts: partFiles.length,
      files: partFiles,
    });

  } catch (err) {
    console.error('Downloader error:', err.message);
    cleanup(outputPath);
    cleanup(compressedPath);
    return res.status(500).json({ error: 'Download failed: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 PocketAssist Downloader running on port ${PORT}`);
});
