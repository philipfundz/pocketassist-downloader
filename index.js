require('dotenv').config();
const { execSync } = require('child_process');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const {
  setupCookies,
  detectPlatform,
  cleanup,
  parseYtDlpError,
  DEFAULT_DESCRIPTION,
} = require('./helpers');
const { downloadVideo } = require('./downloader');
const { fetchDescription } = require('./metadata');
const circuitBreaker = require('./circuitBreaker');

const app = express();
app.use(express.json());

const PORT              = process.env.PORT || 3001;
const TEMP_DIR           = path.join(__dirname, 'temp');
const AUTH_TOKEN         = process.env.AUTH_TOKEN || 'pocketassist-dl-secret';
const MAX_CONCURRENT     = parseInt(process.env.MAX_CONCURRENT_JOBS || '2', 10);
const BOT_CALLBACK_URL   = process.env.BOT_CALLBACK_URL || null;   // e.g. https://pocketassist.onrender.com/downloader-callback
const BOT_CALLBACK_TOKEN = process.env.BOT_CALLBACK_TOKEN || AUTH_TOKEN;

// Jobs older than this get swept from memory (they've long since been
// delivered or given up on) — prevents unbounded memory growth.
const JOB_RETENTION_MS = 60 * 60 * 1000; // 1 hour

// ─── Boot Checks ──────────────────────────────────────────────────────────────

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
  console.log('✓ FFmpeg available');
} catch {
  console.error('✗ CRITICAL: FFmpeg missing — video splitting will fail');
}

try {
  const version = execSync(`${path.join(__dirname, 'node_modules/yt-dlp-exec/bin/yt-dlp')} --version`).toString().trim();
  console.log('✓ yt-dlp version:', version);
} catch (e) {
  console.warn('Could not determine yt-dlp version:', e.message);
}

console.log('Skipping yt-dlp auto-update (avoids GitHub rate limits on Render).');

setupCookies();

if (!BOT_CALLBACK_URL) {
  console.warn(
    '⚠ BOT_CALLBACK_URL not set — job results will NOT be pushed to the bot automatically. ' +
    'The bot must poll GET /status/:jobId instead.'
  );
}

// ─── Job Store + Queue ─────────────────────────────────────────────────────────
// jobs: Map<jobId, jobObject>
// jobQueue: array of jobIds waiting for a free worker slot

const jobs = new Map();
const jobQueue = [];
let activeWorkers = 0;

const makeJob = ({ url, phone, platform }) => ({
  id: uuidv4(),
  url,
  phone: phone || null,
  platform,
  platformKey: circuitBreaker.getPlatformKey(platform),
  status: 'queued',       // queued -> processing -> completed | failed
  result: null,
  createdAt: Date.now(),
  startedAt: null,
  finishedAt: null,
});

const enqueueJob = (job) => {
  jobs.set(job.id, job);
  jobQueue.push(job.id);
  console.log(`[Job ${job.id}] queued (${job.platformKey}) — queue depth now ${jobQueue.length}`);
  processQueue();
};

const processQueue = () => {
  while (activeWorkers < MAX_CONCURRENT && jobQueue.length > 0) {
    const jobId = jobQueue.shift();
    activeWorkers++;
    runJob(jobId)
      .catch((err) => {
        // Should never happen — runJob catches internally — but guarantees
        // a stuck promise can never silently hold a worker slot forever.
        console.error(`[Job ${jobId}] unexpected uncaught error in runJob:`, err.message);
      })
      .finally(() => {
        activeWorkers--;
        processQueue();
      });
  }
};

const runJob = async (jobId) => {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = 'processing';
  job.startedAt = Date.now();
  console.log(`[Job ${jobId}] processing started — ${job.url}`);

  try {
    if (circuitBreaker.isOpen(job.platformKey)) {
      throw Object.assign(new Error('PLATFORM_CIRCUIT_OPEN'), {
        userMessage: `${capitalize(job.platformKey)} downloads are temporarily unavailable — please try again in a few minutes.`,
      });
    }

    console.log(`[Job ${jobId}] fetching description + video in parallel`);
    const descriptionPromise = (job.platform.isFacebook || job.platform.isTikTok || job.platform.isTwitter)
  ? Promise.resolve(DEFAULT_DESCRIPTION)
  : fetchDescription(job.url, job.platform);

    const [descriptionResult, downloadResult] = await Promise.allSettled([
      descriptionPromise,
      downloadVideo(job.url, job.platform),
    ]);

    if (downloadResult.status === 'rejected') {
      circuitBreaker.recordFailure(job.platformKey);
      throw downloadResult.reason;
    }
    circuitBreaker.recordSuccess(job.platformKey);

    const { files, videoOnly, totalParts } = downloadResult.value;
    const description = descriptionResult.status === 'fulfilled'
      ? descriptionResult.value
      : DEFAULT_DESCRIPTION;

    job.status = 'completed';
    job.result = {
      success: true,
      split: files.length > 1,
      totalParts,
      videoOnly,
      files: files.map((fileUrl, index) => ({
        url: fileUrl,
        part: index + 1,
        total: files.length,
        ...(index === 0 && { description }),
      })),
    };
    console.log(`[Job ${jobId}] completed successfully — ${files.length} file(s)`);

  } catch (error) {
    console.error(`[Job ${jobId}] failed:`, error.message);
    job.status = 'failed';

    if (error.message === 'DURATION_EXCEEDED' || error.userMessage) {
      job.result = { success: false, error: error.userMessage };
    } else {
      const stderrText = error.stderr || error.message || '';
      const userMessage =
        parseYtDlpError(stderrText) ||
        'Failed to download this video. The link may be unsupported or the video is unavailable.';
      job.result = { success: false, error: userMessage };
    }

  } finally {
    job.finishedAt = Date.now();
    await dispatchCallback(job);
  }
};

const dispatchCallback = async (job) => {
  if (!BOT_CALLBACK_URL) {
    console.warn(`[Job ${job.id}] no BOT_CALLBACK_URL configured — bot must poll /status/${job.id}`);
    return;
  }
  try {
    await axios.post(
      BOT_CALLBACK_URL,
      { jobId: job.id, phone: job.phone, ...job.result },
      { headers: { 'x-auth-token': BOT_CALLBACK_TOKEN }, timeout: 15000 }
    );
    console.log(`[Job ${job.id}] callback delivered to bot`);
  } catch (err) {
    console.error(
      `[Job ${job.id}] callback delivery FAILED (${err.message}) — bot should fall back to polling /status/${job.id}`
    );
  }
};

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Periodic sweep of old finished jobs so the jobs Map doesn't grow forever
setInterval(() => {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  let swept = 0;
  for (const [id, job] of jobs.entries()) {
    if (job.finishedAt && job.finishedAt < cutoff) {
      jobs.delete(id);
      swept++;
    }
  }
  if (swept > 0) console.log(`Swept ${swept} old job record(s) from memory.`);
}, 15 * 60 * 1000);

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
    queueDepth: jobQueue.length,
    activeWorkers,
    maxConcurrent: MAX_CONCURRENT,
    circuitBreakers: circuitBreaker.getStates(),
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
  res.on('close', () => cleanup(filePath)); // handles aborted requests too
});

// ─── Download Route (now async — returns a jobId immediately) ────────────────

app.post('/download', (req, res) => {
  const { url, phone } = req.body;

  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ success: false, error: 'Please provide a valid video URL.' });
  }

  const platform = detectPlatform(url);
  const platformKey = circuitBreaker.getPlatformKey(platform);

  if (circuitBreaker.isOpen(platformKey)) {
    return res.status(503).json({
      success: false,
      error: `${capitalize(platformKey)} downloads are temporarily unavailable — please try again in a few minutes.`,
    });
  }

  const job = makeJob({ url, phone, platform });
  enqueueJob(job);

  return res.status(202).json({
    success: true,
    jobId: job.id,
    status: 'queued',
  });
});

// ─── Status Route (polling backup for the callback) ───────────────────────────

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found (it may have expired).' });

  if (job.status === 'completed' || job.status === 'failed') {
    return res.json({ jobId: job.id, status: job.status, ...job.result });
  }

  return res.json({ jobId: job.id, status: job.status });
});

// ─── Fallback Error Handlers ──────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found.' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err.stack);
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
  console.log(`PocketAssist Downloader running on port ${PORT} (max ${MAX_CONCURRENT} concurrent jobs)`);
});
