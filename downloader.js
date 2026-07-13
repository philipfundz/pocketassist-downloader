const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const {
  YT_COOKIES_PATH,
  IG_COOKIES_PATH,
  FB_COOKIES_PATH,
  TK_COOKIES_PATH,
  cleanup,
} = require('./helpers');

const YT_DLP_BIN   = path.join(__dirname, 'node_modules/yt-dlp-exec/bin/yt-dlp');
const TEMP_DIR      = path.join(__dirname, 'temp');
const SAFE_LIMIT_MB = 10;
const MAX_PARTS     = 5;
const MAX_DURATION  = 900; // 15 minutes in seconds
const FFMPEG_TIMEOUT = 45000; // 45s

// ─── Duration Pre-check ───────────────────────────────────────────────────────

/**
 * Fetch video duration in seconds via yt-dlp --dump-json.
 * Returns null if it cannot be determined (so we don't block the download).
 */
const fetchDuration = (url, platform) => {
  return new Promise((resolve) => {
    const { isYouTube, isInstagram, isFacebook, isTikTok } = platform;

    const args = [
      url,
      '--dump-single-json',
      '--skip-download',
      '--no-playlist',
      '--no-check-certificates',
    ];

    if (isYouTube && process.env.YOUTUBE_COOKIES) args.push('--cookies', YT_COOKIES_PATH);
    if (isInstagram && process.env.INSTAGRAM_COOKIES) args.push('--cookies', IG_COOKIES_PATH);
    if (isFacebook && process.env.FACEBOOK_COOKIES) args.push('--cookies', FB_COOKIES_PATH);
    if (isTikTok && process.env.TIKTOK_COOKIES) args.push('--cookies', TK_COOKIES_PATH);

    let stdout = '';
    let finished = false;
    const proc = spawn(YT_DLP_BIN, args);

    const timer = setTimeout(() => {
      if (!finished) { finished = true; proc.kill('SIGKILL'); resolve(null); }
    }, 20000);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        const info = JSON.parse(stdout);
        resolve(typeof info.duration === 'number' ? info.duration : null);
      } catch { resolve(null); }
    });
    proc.on('error', () => { if (!finished) { finished = true; clearTimeout(timer); resolve(null); } });
  });
};

// ─── Build yt-dlp Args ────────────────────────────────────────────────────────

const buildArgs = (url, outputPath, platform) => {
  const { isYouTube, isInstagram, isFacebook, isTikTok } = platform;

  const args = [
    url,
    '-o', outputPath,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--no-check-certificates',
  ];

  // Format selection per platform
  if (isFacebook) {
    // Permissive — avoids DRM audio container mismatch on first attempt
    args.push('-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]/best');
  } else if (isYouTube) {
    args.push('-f', [
      'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]',
      'best[height<=720][ext=mp4]',
      'best[height<=480]',
      'worst',
    ].join('/'));
    args.push('--extractor-args', 'youtube:player_client=web');
    if (process.env.YOUTUBE_COOKIES) args.push('--cookies', YT_COOKIES_PATH);
  } else if (isTikTok) {
    args.push('-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]/best');
    if (process.env.TIKTOK_COOKIES) args.push('--cookies', TK_COOKIES_PATH);
  } else {
    // Instagram, Twitter, generic
    args.push('-f', [
      'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]',
      'best[height<=720][ext=mp4]',
      'best[height<=480]',
      'best',
    ].join('/'));
  }

  if (isInstagram) {
    args.push(
      '--add-header', 'referer:https://www.instagram.com/',
      '--add-header', 'x-ig-app-id:936619743392459',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    if (process.env.INSTAGRAM_COOKIES) args.push('--cookies', IG_COOKIES_PATH);
  }

  if (isFacebook) {
    args.push(
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '--add-header', 'referer:https://www.facebook.com/'
    );
    if (process.env.FACEBOOK_COOKIES) args.push('--cookies', FB_COOKIES_PATH);
  }

  return args;
};

// ─── Facebook Video-Only Fallback Args ───────────────────────────────────────

const buildFbVideoOnlyArgs = (url, outputPath) => {
  const args = [
    url,
    '-o', outputPath,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--no-check-certificates',
    '-f', 'bestvideo[height<=720][ext=mp4]/bestvideo[height<=720]/best[height<=720]',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '--add-header', 'referer:https://www.facebook.com/',
  ];
  if (process.env.FACEBOOK_COOKIES) args.push('--cookies', FB_COOKIES_PATH);
  return args;
};

// ─── Spawn yt-dlp ─────────────────────────────────────────────────────────────

const runYtDlp = (args, timeoutMs = 120000) => {
  return new Promise((resolve, reject) => {
    const proc = spawn(YT_DLP_BIN, args);
    let stderr = '';
    let finished = false;

    proc.stdout.on('data', (d) => process.stdout.write(d));
    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      process.stderr.write(chunk);
    });

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        proc.kill('SIGKILL');
        reject(Object.assign(new Error('DOWNLOAD_TIMEOUT'), { stderr }));
      }
    }, timeoutMs);

    proc.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(Object.assign(new Error(`yt-dlp exited with code ${code}`), { stderr }));
    });

    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      err.stderr = stderr;
      reject(err);
    });
  });
};

// ─── FFmpeg Split ─────────────────────────────────────────────────────────────

const splitVideo = (inputPath) => {
  return new Promise((resolve, reject) => {
    const baseId = uuidv4();
    const pattern = path.join(TEMP_DIR, `${baseId}_part%03d.mp4`);

    const args = [
      '-i', inputPath,
      '-c', 'copy',
      '-map', '0',
      '-f', 'segment',
      '-segment_time', '60',
      '-reset_timestamps', '1',
      pattern,
    ];

    const proc = spawn('ffmpeg', args);
    let stderr = '';
    let finished = false;

    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        proc.kill('SIGKILL');
        reject(new Error('SPLIT_TIMEOUT'));
      }
    }, FFMPEG_TIMEOUT);

    proc.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) resolve(baseId);
      else {
        console.error('ffmpeg split stderr:', stderr.slice(-1000));
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });
  });
};

// ─── Main Download Function ───────────────────────────────────────────────────

/**
 * Download a video, split if large, return file list.
 * Handles Facebook video-only fallback automatically.
 *
 * @returns {{ files: string[], videoOnly: boolean }}
 */
const downloadVideo = async (url, platform) => {
  const { isFacebook } = platform;

  // ── Duration pre-check ──
  console.log('Checking video duration...');
  const duration = await fetchDuration(url, platform);

  if (duration !== null && duration > MAX_DURATION) {
    const mins = Math.round(duration / 60);
    throw Object.assign(
      new Error('DURATION_EXCEEDED'),
      { userMessage: `This video is ${mins} minutes long. PocketAssist can only download videos up to 15 minutes.` }
    );
  }

  const fileId  = uuidv4();
  const outputPath = path.join(TEMP_DIR, `${fileId}.mp4`);

  // ── First attempt ──
  const args = buildArgs(url, outputPath, platform);
  console.log(`Starting download: ${url}`);
  console.log('yt-dlp args:', args.join(' '));

  let videoOnly = false;

  try {
    await runYtDlp(args, 120000);
  } catch (err) {
    const stderr = err.stderr || '';
    const isDrmAudioError =
      stderr.includes('unable to obtain file audio codec') ||
      stderr.includes('Audio format') ||
      stderr.includes('m4a') ||
      stderr.includes('Requested format is not available') ||
      stderr.includes('audio') && stderr.includes('merge');

    // Facebook DRM audio fallback — retry video-only
    if (isFacebook && isDrmAudioError) {
      console.warn('Facebook audio merge failed — retrying video-only...');
      cleanup(outputPath);

      const fbArgs = buildFbVideoOnlyArgs(url, outputPath);
      try {
        await runYtDlp(fbArgs, 120000);
        videoOnly = true;
        console.log('Facebook video-only fallback succeeded.');
      } catch (fbErr) {
        cleanup(outputPath);
        throw fbErr; // bubble up to route handler
      }
    } else {
      cleanup(outputPath);
      throw err;
    }
  }

  // ── File check ──
  if (!fs.existsSync(outputPath)) {
    throw new Error('Output file missing after download.');
  }

  const stats = fs.statSync(outputPath);
  const fileSizeMB = stats.size / (1024 * 1024);
  console.log(`Download complete. Size: ${fileSizeMB.toFixed(2)}MB | Video-only: ${videoOnly}`);

  // ── Small file — serve as-is ──
  if (fileSizeMB <= SAFE_LIMIT_MB) {
    return { files: [`/file/${fileId}.mp4`], videoOnly };
  }

  // ── Large file — split ──
  console.log(`File exceeds ${SAFE_LIMIT_MB}MB — splitting...`);
  let baseSplitId;
  try {
    baseSplitId = await splitVideo(outputPath);
  } finally {
    cleanup(outputPath); // always remove original after split attempt
  }

  const parts = fs.readdirSync(TEMP_DIR)
    .filter(f => f.startsWith(baseSplitId) && f.endsWith('.mp4'))
    .sort()
    .slice(0, MAX_PARTS)
    .map(f => `/file/${f}`);

  if (parts.length === 0) {
    throw new Error('Video splitting failed to produce any parts.');
  }

  return { files: parts, videoOnly };
};

module.exports = { downloadVideo };