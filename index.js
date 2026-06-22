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

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

const cleanup = (filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
};

// Auth middleware
app.use((req, res, next) => {
  const token = req.headers['x-auth-token'];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pocketassist-downloader' });
});

// Main download endpoint
app.post('/download', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let outputPath, compressedPath;
  let ffmpegCommand = null;

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
      return res.status(400).json({ error: 'Could not fetch video info — link may be invalid or unsupported' });
    }

    const durationSeconds = videoInfo?.duration || 0;

    if (durationSeconds > 300) {
      const mins = Math.floor(durationSeconds / 60);
      return res.status(400).json({ error: `Video is ${mins} min long — maximum is 5 minutes` });
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
      format: 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=360]/worst',
      mergeOutputFormat: 'mp4',
      noPlaylist: true,
      noCheckCertificates: true,
    });

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Download failed — file not created' });
    }

    let finalPath = outputPath;
    const stats = fs.statSync(outputPath);
    const fileSizeMB = stats.size / (1024 * 1024);

    // Compress if over 10MB
    if (fileSizeMB > 10) {
      compressedPath = path.join(TEMP_DIR, `${uuidv4()}_compressed.mp4`);

      const dynamicTimeoutMs = 90000 + Math.ceil((durationSeconds / 60) * 15000);

      await new Promise((resolve, reject) => {
        let finished = false;

        ffmpegCommand = ffmpeg(outputPath)
          .outputOptions([
            '-vcodec libx264',
            '-crf 28',
            '-preset fast',
            '-vf scale=480:-2',
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

      if (!fs.existsSync(compressedPath)) {
        return res.status(500).json({ error: 'Compression failed — output not created' });
      }

      const compressedStats = fs.statSync(compressedPath);
      if (compressedStats.size > 15 * 1024 * 1024) {
        cleanup(compressedPath);
        return res.status(400).json({ error: 'Video too large even after compression — try a shorter clip' });
      }

      finalPath = compressedPath;
    }

    // Send video file back
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('X-Caption', encodeURIComponent(captionText));
    res.setHeader('X-Duration', durationSeconds);
    const fileStream = fs.createReadStream(finalPath);
    fileStream.pipe(res);
    fileStream.on('end', () => {
      cleanup(outputPath);
      cleanup(compressedPath);
    });

  } catch (err) {
    console.error('Downloader error:', err.message);
    cleanup(outputPath);
    cleanup(compressedPath);

    if (err.message === 'COMPRESSION_TIMEOUT') {
      return res.status(500).json({ error: 'Compression took too long — try a shorter clip' });
    }
    return res.status(500).json({ error: 'Download failed: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 PocketAssist Downloader running on port ${PORT}`);
});