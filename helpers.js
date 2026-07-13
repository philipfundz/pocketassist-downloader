const fs = require('fs');
const path = require('path');

// ─── Cookie Paths ─────────────────────────────────────────────────────────────

const YT_COOKIES_PATH = '/tmp/yt_cookies.txt';
const IG_COOKIES_PATH = '/tmp/ig_cookies.txt';
const FB_COOKIES_PATH = '/tmp/fb_cookies.txt';
const TK_COOKIES_PATH = '/tmp/tk_cookies.txt';

const setupCookies = () => {
  const cookieMap = [
    { env: 'YOUTUBE_COOKIES',   path: YT_COOKIES_PATH,  label: 'YouTube'   },
    { env: 'INSTAGRAM_COOKIES', path: IG_COOKIES_PATH,  label: 'Instagram' },
    { env: 'FACEBOOK_COOKIES',  path: FB_COOKIES_PATH,  label: 'Facebook'  },
    { env: 'TIKTOK_COOKIES',    path: TK_COOKIES_PATH,  label: 'TikTok'    },
  ];

  for (const { env, path: cookiePath, label } of cookieMap) {
    if (process.env[env]) {
      try {
        fs.writeFileSync(cookiePath, process.env[env]);
        console.log(`${label} cookies written to ${cookiePath}`);
      } catch (e) {
        console.error(`Failed to write ${label} cookies:`, e.message);
      }
    }
  }
};

// ─── Platform Detection ───────────────────────────────────────────────────────

const detectPlatform = (url) => ({
  isYouTube:   url.includes('youtube.com')  || url.includes('youtu.be'),
  isInstagram: url.includes('instagram.com'),
  isFacebook:  url.includes('facebook.com') || url.includes('fb.watch'),
  isTikTok:    url.includes('tiktok.com'),
  isTwitter:   url.includes('twitter.com')  || url.includes('x.com'),
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────

const cleanup = (filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
};

const cleanupDir = (dir, prefix) => {
  try {
    fs.readdirSync(dir)
      .filter(f => f.startsWith(prefix))
      .forEach(f => cleanup(path.join(dir, f)));
  } catch (e) {
    console.error('Cleanup dir error:', e.message);
  }
};

// ─── Error Parser ─────────────────────────────────────────────────────────────

const DEFAULT_DESCRIPTION =
  '📥 Downloaded via PocketAssist\n' +
  'Your AI-powered WhatsApp utility bot.\n' +
  'Get started → wa.me/2348120112564';

const parseYtDlpError = (stderr = '') => {
  if (!stderr) return null;

  if (stderr.includes('Video unavailable') || stderr.includes('This video is not available'))
    return 'This video is unavailable or has been removed.';

  if (stderr.includes('Private video') || stderr.includes('private'))
    return 'This video is private and cannot be downloaded.';

  if (stderr.includes('age') && stderr.includes('confirm'))
    return 'This video requires age verification and cannot be downloaded without cookies.';

  if (stderr.includes('login') || stderr.includes('Login') || stderr.includes('sign in'))
    return 'This video requires a login to access.';

  if (stderr.includes('Unsupported URL') || stderr.includes('[generic]'))
    return "That doesn't look like a supported video link. Please share the direct link to the video.";

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

module.exports = {
  YT_COOKIES_PATH,
  IG_COOKIES_PATH,
  FB_COOKIES_PATH,
  TK_COOKIES_PATH,
  setupCookies,
  detectPlatform,
  cleanup,
  cleanupDir,
  parseYtDlpError,
  DEFAULT_DESCRIPTION,
};