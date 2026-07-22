const { spawn } = require('child_process');
const path = require('path');
const {
  YT_COOKIES_PATH,
  IG_COOKIES_PATH,
  FB_COOKIES_PATH,
  TK_COOKIES_PATH,
  DEFAULT_DESCRIPTION,
} = require('./helpers');

const YT_DLP_BIN = path.join(__dirname, 'node_modules/yt-dlp-exec/bin/yt-dlp');

/**
 * Fetch only the description of a video.
 * Returns DEFAULT_DESCRIPTION if the video has no description or fetch fails.
 *
 * @param {string} url
 * @param {{ isYouTube, isInstagram, isFacebook, isTikTok, isTwitter }} platform
 * @returns {Promise<string>}
 */
const fetchDescription = (url, platform) => {
  return new Promise((resolve) => {
    const { isYouTube, isInstagram, isFacebook, isTikTok } = platform;

    const args = [
      url,
      '--dump-single-json',
      '--skip-download',
      '--no-playlist',
      '--no-check-certificates',
    ];

    if (isYouTube && process.env.YOUTUBE_COOKIES)
      args.push('--cookies', YT_COOKIES_PATH);

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

    if (isTikTok && process.env.TIKTOK_COOKIES)
      args.push('--cookies', TK_COOKIES_PATH);

    let stdout = '';
    let finished = false;

    const proc = spawn(YT_DLP_BIN, args);

    // timeout — if info fetch hangs, just fall back to default
    const timer = setTimeout(() => {
  if (!finished) {
    finished = true;
    proc.kill('SIGKILL');
    console.warn('Metadata fetch timed out — using default description');
    resolve(DEFAULT_DESCRIPTION);
  }
}, 5000);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });

    proc.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0 || !stdout.trim()) {
        console.warn('Metadata fetch failed — using default description');
        return resolve(DEFAULT_DESCRIPTION);
      }

      try {
        const info = JSON.parse(stdout);
        const raw = (info.description || '').trim();

        if (!raw) return resolve(DEFAULT_DESCRIPTION);

        // Strip t.co and other tracking links, cap at 800 chars
        const cleaned = raw
          .replace(/https?:\/\/t\.co\/\S+/g, '')
          .replace(/\s{3,}/g, '\n\n')
          .trim()
          .slice(0, 800);

        resolve(cleaned || DEFAULT_DESCRIPTION);
      } catch (e) {
        console.warn('Metadata JSON parse error — using default description');
        resolve(DEFAULT_DESCRIPTION);
      }
    });

    proc.on('error', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(DEFAULT_DESCRIPTION);
    });
  });
};

module.exports = { fetchDescription };