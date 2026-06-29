require('dotenv').config();
const { spawn } = require('child_process');
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

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

const cleanup = (filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
};

// Health check — public, no auth
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pocketassist-downloader' });
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

// Main download endpoint
app.post('/download', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const isInstagram = url.includes('instagram.com');

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
        ...(isInstagram ? {
          addHeader: [
            'referer:https://www.instagram.com/',
            'x-ig-app-id:936619743392459',
          ],
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        } : {}),
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
      ...(isInstagram ? {
        addHeader: [
          'referer:https://www.instagram.com/',
          'x-ig-app-id:936619743392459',
        ],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      } : {}),
    });

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Download failed — file not created' });
    }

    const stats = fs.statSync(outputPath);
    const fileSizeMB = stats.size / (1024 * 1024);

    let candidatePath = outputPath;
    let candidateSizeMB = fileSizeMB;

    if (fileSizeMB > 10) {
      compressedPath = path.join(TEMP_DIR, `${uuidv4()}_compressed.mp4`);
      const dynamicTimeoutMs = 90000 + Math.ceil((durationSeconds / 60) * 15000);

      try {
        await new Promise((resolve, reject) => {
          let finished = false;
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

    // Case 2: still too big — split into parts by time
    const bytesPerSecond = (candidateSizeMB * 1024 * 1024) / durationSeconds;
    let segmentSeconds = Math.floor((SAFE_LIMIT_MB * 1024 * 1024) / bytesPerSecond);
    if (segmentSeconds < 1) segmentSeconds = 1;

    let parts = Math.ceil(durationSeconds / segmentSeconds);
    if (parts > MAX_PARTS) {
      segmentSeconds = Math.ceil(durationSeconds / MAX_PARTS);
      parts = MAX_PARTS;
    }

    let baseId;
    try {
      baseId = await splitVideo(candidatePath, segmentSeconds);
    } catch (splitErr) {
      console.error('Split failed:', splitErr.message);
      cleanup(outputPath);
      cleanup(compressedPath);
      return res.status(400).json({ error: 'Video too large to send even after splitting — try a shorter clip' });
    }

    const partFiles = fs.readdirSync(TEMP_DIR)
      .filter((f) => f.startsWith(baseId))
      .sort();

    if (partFiles.length === 0) {
      cleanup(outputPath);
      cleanup(compressedPath);
      return res.status(500).json({ error: 'Split produced no files' });
    }

    const oversizedPart = partFiles.find((f) => {
      const size = fs.statSync(path.join(TEMP_DIR, f)).size / (1024 * 1024);
      return size > 15;
    });

    if (oversizedPart) {
      partFiles.forEach((f) => cleanup(path.join(TEMP_DIR, f)));
      cleanup(outputPath);
      cleanup(compressedPath);
      return res.status(400).json({ error: 'Video too dense to split cleanly — try a shorter or lower-quality clip' });
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
    console.error('Downloader error:', err.message);
    cleanup(outputPath);
    cleanup(compressedPath);
    return res.status(500).json({ error: 'Download failed — please try again or use a different link' });
  }
});

// Periodic safety sweep — removes orphaned temp files
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const MAX_FILE_AGE_MS = 2 * 60 * 60 * 1000;

setInterval(() => {
  try {
    const now = Date.now();
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > MAX_FILE_AGE_MS) {
        fs.unlinkSync(filePath);
        console.log('Swept stale temp file:', file);
      }
    }
  } catch (e) {
    console.error('Sweep error:', e.message);
  }
}, SWEEP_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`🚀 PocketAssist Downloader running on port ${PORT}`);
});
