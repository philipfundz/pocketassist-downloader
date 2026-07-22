const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const {
  YT_COOKIES_PATH,
  IG_COOKIES_PATH,
  FB_COOKIES_PATH,
  TK_COOKIES_PATH,
} = require('./helpers');

const YT_DLP_BIN    = path.join(__dirname, 'node_modules/yt-dlp-exec/bin/yt-dlp');
const TEMP_DIR       = path.join(__dirname, 'temp');
const SAFE_LIMIT_MB  = 14;
const MAX_PARTS_CEIL = 20;       // sanity ceiling only — not a quality-degrading cap
const MAX_DURATION   = 900;      // 15 minutes in seconds

// Minimum acceptable bitrate (KB per second of video). Below this, the file
// is almost certainly a thumbnail/preview stream rather than the real video.
// A very low quality real video (e.g. 360p) is still comfortably above this.
const MIN_KB_PER_SECOND = 15;

// ─── Duration Pre-check ───────────────────────────────────────────────────────

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
    proc.on('close', () => {
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

// ─── Format Fallback Chain ────────────────────────────────────────────────────
// Each platform gets an ORDERED list of format selectors to try. If a download
// "succeeds" (exit code 0) but the output fails validation (see validateFile),
// we move to the next entry instead of trusting the first result blindly.

const getFormatChain = (platform) => {
  const { isFacebook, isYouTube, isTikTok } = platform;

  if (isFacebook) {
    return [
      'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
      'bestvideo[height<=720][ext=mp4]/bestvideo[height<=720]/best[height<=720]', // video-only DRM fallback
      'best',
    ];
  }

  if (isYouTube) {
    return [
      'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]',
      'best[height<=720][ext=mp4]',
      'best[height<=480]',
      'worst',
    ];
  }

  if (isTikTok) {
    return [
      'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
      'best',
    ];
  }

  // Instagram, Twitter, generic
  return [
    'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]',
    'best[height<=720][ext=mp4]',
    'best[height<=480]',
    'best',
  ];
};

// ─── Build yt-dlp Args for a Given Format Selector ───────────────────────────

const buildArgs = (url, outputPath, platform, formatSelector) => {
  const { isYouTube, isInstagram, isFacebook, isTikTok } = platform;

  const args = [
    url,
    '-o', outputPath,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--no-check-certificates',
    '-f', formatSelector,
  ];

  if (isYouTube) {
    args.push('--extractor-args', 'youtube:player_client=web');
    if (process.env.YOUTUBE_COOKIES) args.push('--cookies', YT_COOKIES_PATH);
  }

  if (isTikTok && process.env.TIKTOK_COOKIES) {
    args.push('--cookies', TK_COOKIES_PATH);
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
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      '--add-header', 'referer:https://www.facebook.com/',
      '--add-header', 'accept-language:en-US,en;q=0.9',
      '--socket-timeout', '30',
      '--geo-bypass'
    );
    if (process.env.FACEBOOK_COOKIES) args.push('--cookies', FB_COOKIES_PATH);
  }

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

// ─── ffprobe Helpers ──────────────────────────────────────────────────────────

const probeDuration = (filePath) => {
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`
    ).toString().trim();
    const duration = parseFloat(out);
    return Number.isFinite(duration) ? duration : null;
  } catch {
    return null;
  }
};

const probeHasVideoStream = (filePath) => {
  try {
    const out = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=codec_type -of csv=p=0 "${filePath}"`
    ).toString().trim();
    return out === 'video';
  } catch {
    return false;
  }
};

/**
 * Returns sorted keyframe (I-frame) timestamps in seconds.
 */
const probeKeyframeTimestamps = (filePath) => {
  try {
    const out = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags -of csv=print_section=0 "${filePath}"`,
      { maxBuffer: 1024 * 1024 * 20 }
    ).toString().trim();

    const timestamps = [];
    for (const line of out.split('\n')) {
      const [ptsTimeStr, flags] = line.split(',');
      if (flags && flags.includes('K')) {
        const t = parseFloat(ptsTimeStr);
        if (Number.isFinite(t)) timestamps.push(t);
      }
    }
    return timestamps.sort((a, b) => a - b);
  } catch {
    return [];
  }
};

// ─── Output Validation ────────────────────────────────────────────────────────
// Catches the "0.14MB Instagram reel" class of bug: yt-dlp exits 0, but the
// file is a thumbnail/preview stream rather than the real video.

const validateFile = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return { valid: false, reason: 'Output file missing after download.' };
  }

  const stats = fs.statSync(filePath);
  const fileSizeMB = stats.size / (1024 * 1024);

  if (fileSizeMB < 0.05) {
    return { valid: false, reason: 'File is essentially empty.' };
  }

  if (!probeHasVideoStream(filePath)) {
    return { valid: false, reason: 'File has no valid video stream.' };
  }

  const duration = probeDuration(filePath);
  if (duration && duration > 0) {
    const kbPerSecond = (stats.size / 1024) / duration;
    if (kbPerSecond < MIN_KB_PER_SECOND) {
      return {
        valid: false,
        reason: `Suspiciously low bitrate (${kbPerSecond.toFixed(1)}KB/s) — likely a thumbnail/preview stream, not the real video.`,
      };
    }
  }

  return { valid: true, fileSizeMB, duration };
};

// ─── FFmpeg Split (Keyframe-Aware) ────────────────────────────────────────────

const splitVideo = async (inputPath, fileSizeMB) => {
  const baseId = uuidv4();

  const duration = probeDuration(inputPath);
  if (!duration) throw new Error('Unable to determine video duration for splitting.');

  // Parts calculated purely from size — no arbitrary cap, just a sane ceiling
  // so something bizarre (e.g. a corrupt multi-GB file) can't spiral.
  const requiredParts = Math.max(2, Math.min(MAX_PARTS_CEIL, Math.ceil(fileSizeMB / SAFE_LIMIT_MB)));
  const targetSegmentTime = duration / requiredParts;

  const keyframes = probeKeyframeTimestamps(inputPath);

  // Decide whether copy-splitting (fast, keyframe-snapped) is viable, or
  // whether keyframes are too sparse and we need to re-encode with forced
  // keyframes at exact intervals to guarantee clean, even cuts.
  const avgKeyframeGap = keyframes.length > 1
    ? (keyframes[keyframes.length - 1] - keyframes[0]) / (keyframes.length - 1)
    : Infinity;

  const keyframesAreSparse = avgKeyframeGap > targetSegmentTime * 0.5;

  console.log(
    `[Split] duration=${duration.toFixed(1)}s parts=${requiredParts} targetSegment=${targetSegmentTime.toFixed(1)}s ` +
    `keyframes=${keyframes.length} avgGap=${avgKeyframeGap.toFixed(1)}s sparse=${keyframesAreSparse}`
  );

  // Scaled timeout: generous floor, then scales with duration so long videos
  // aren't starved by a fixed ceiling designed for short clips.
  const timeoutMs = Math.max(45000, duration * 1000 * (keyframesAreSparse ? 6 : 3));

  let parts;
  if (keyframesAreSparse) {
    parts = await splitWithReencode(inputPath, baseId, targetSegmentTime, timeoutMs);
  } else {
    parts = await splitWithKeyframeSnap(inputPath, baseId, keyframes, targetSegmentTime, duration, timeoutMs);
  }

  // ── Validate every part before declaring success ──
  const validParts = [];
  for (const partPath of parts) {
    const result = validateFile(partPath);
    if (result.valid) {
      validParts.push(partPath);
    } else {
      console.warn(`[Split] part failed validation, discarding: ${partPath} — ${result.reason}`);
      cleanupFile(partPath);
    }
  }

  if (validParts.length === 0) {
    throw new Error('Video splitting failed to produce any valid parts.');
  }

  return {
    parts: validParts.map((p) => `/file/${path.basename(p)}`),
    totalParts: validParts.length,
  };
};

// Fast path: cut at the keyframe nearest each target boundary. Works well
// whenever keyframes aren't too sparse relative to the segment length.
const splitWithKeyframeSnap = (inputPath, baseId, keyframes, targetSegmentTime, duration, timeoutMs) => {
  return new Promise((resolve, reject) => {
    // Build actual cut points snapped to the nearest available keyframe
    const cutPoints = [0];
    for (let t = targetSegmentTime; t < duration; t += targetSegmentTime) {
      const nearest = keyframes.reduce((best, kf) =>
        Math.abs(kf - t) < Math.abs(best - t) ? kf : best, keyframes[0] ?? t);
      if (nearest > cutPoints[cutPoints.length - 1]) cutPoints.push(nearest);
    }

    const segmentTimesArg = cutPoints.slice(1).join(',');
    const pattern = path.join(TEMP_DIR, `${baseId}_part%03d.mp4`);

    const args = [
      '-i', inputPath,
      '-c', 'copy',
      '-map', '0',
      '-f', 'segment',
      '-segment_times', segmentTimesArg,
      '-reset_timestamps', '1',
      pattern,
    ];

    runFfmpegSplit(args, baseId, timeoutMs, resolve, reject);
  });
};

// Slower fallback: force keyframes at exact intervals via re-encode, then
// split cleanly. Used only when the source's real keyframes are too sparse
// to give clean cuts with -c copy.
const splitWithReencode = (inputPath, baseId, targetSegmentTime, timeoutMs) => {
  return new Promise((resolve, reject) => {
    const pattern = path.join(TEMP_DIR, `${baseId}_part%03d.mp4`);

    const args = [
      '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac',
      '-force_key_frames', `expr:gte(t,n_forced*${targetSegmentTime})`,
      '-map', '0',
      '-f', 'segment',
      '-segment_time', String(targetSegmentTime),
      '-reset_timestamps', '1',
      pattern,
    ];

    console.log('[Split] keyframes too sparse for copy-split — re-encoding with forced keyframes.');
    runFfmpegSplit(args, baseId, timeoutMs, resolve, reject);
  });
};

const runFfmpegSplit = (args, baseId, timeoutMs, resolve, reject) => {
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
  }, timeoutMs);

  proc.on('close', (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);

    if (code !== 0) {
      console.error(stderr.slice(-1000));
      return reject(new Error(`ffmpeg exited with code ${code}`));
    }

    const parts = fs.readdirSync(TEMP_DIR)
      .filter((f) => f.startsWith(baseId))
      .sort()
      .map((f) => path.join(TEMP_DIR, f));

    resolve(parts);
  });

  proc.on('error', (err) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    reject(err);
  });
};

const cleanupFile = (filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
};

// ─── Main Download Function ───────────────────────────────────────────────────

/**
 * Download a video, validating output and trying the next format in the
 * fallback chain if validation fails. Splits if the file is large.
 *
 * @returns {{ files: string[], videoOnly: boolean, totalParts: number }}
 */
const downloadVideo = async (url, platform) => {
  console.log('Checking video duration...');
  const duration = await fetchDuration(url, platform);

  if (duration !== null && duration > MAX_DURATION) {
    const mins = Math.round(duration / 60);
    throw Object.assign(
      new Error('DURATION_EXCEEDED'),
      { userMessage: `This video is ${mins} minutes long. PocketAssist can only download videos up to 15 minutes.` }
    );
  }

  const formatChain = getFormatChain(platform);
  let lastError = null;

  for (let attempt = 0; attempt < formatChain.length; attempt++) {
    const formatSelector = formatChain[attempt];
    const fileId = uuidv4();
    const outputPath = path.join(TEMP_DIR, `${fileId}.mp4`);
    const args = buildArgs(url, outputPath, platform, formatSelector);

    console.log(`Attempt ${attempt + 1}/${formatChain.length} — format: ${formatSelector}`);

    try {
      await runYtDlp(args, 120000);
    } catch (err) {
      cleanupFile(outputPath);
      lastError = err;
      console.warn(`Attempt ${attempt + 1} failed to download: ${err.message}`);
      continue; // try next format in chain
    }

    const validation = validateFile(outputPath);
    if (!validation.valid) {
      console.warn(`Attempt ${attempt + 1} produced invalid output: ${validation.reason} — trying next format.`);
      cleanupFile(outputPath);
      lastError = new Error(validation.reason);
      continue;
    }

    // ── Valid file — this is the one we use ──
    const videoOnly = attempt > 0 && platform.isFacebook; // matches old "DRM fallback" semantics
    console.log(`Download complete on attempt ${attempt + 1}. Size: ${validation.fileSizeMB.toFixed(2)}MB`);

    if (validation.fileSizeMB <= SAFE_LIMIT_MB) {
      return {
        files: [`/file/${fileId}.mp4`],
        videoOnly,
        totalParts: 1,
      };
    }

    console.log(`File exceeds ${SAFE_LIMIT_MB}MB — splitting...`);
    let splitResult;
    try {
      splitResult = await splitVideo(outputPath, validation.fileSizeMB);
    } finally {
      cleanupFile(outputPath);
    }

    return {
      files: splitResult.parts,
      videoOnly,
      totalParts: splitResult.totalParts,
    };
  }

  // Every format in the chain failed or produced invalid output
  throw lastError || new Error('All download attempts failed.');
};

module.exports = { downloadVideo };