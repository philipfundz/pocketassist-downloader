// ─── Per-Platform Circuit Breaker ─────────────────────────────────────────────
// Tracks rolling failure counts per platform. If a platform fails too often in
// a short window, we stop hammering it (protects the server's IP from harder
// blocks) and return a clear "try again shortly" message instead of a silent
// failure or a generic error.

const FAILURE_WINDOW_MS = 5 * 60 * 1000;   // look at failures in the last 5 min
const FAILURE_THRESHOLD = 5;                // this many failures in the window trips it
const OPEN_DURATION_MS  = 3 * 60 * 1000;   // stay open (blocking) for 3 min once tripped

// state per platform key: { failures: [timestamps], openUntil: number|null }
const state = new Map();

const getState = (platformKey) => {
  if (!state.has(platformKey)) {
    state.set(platformKey, { failures: [], openUntil: null });
  }
  return state.get(platformKey);
};

const pruneOldFailures = (s) => {
  const cutoff = Date.now() - FAILURE_WINDOW_MS;
  s.failures = s.failures.filter((ts) => ts > cutoff);
};

/**
 * Returns true if this platform is currently circuit-open (should be blocked).
 * Automatically closes the circuit once OPEN_DURATION_MS has passed.
 */
const isOpen = (platformKey) => {
  const s = getState(platformKey);
  if (s.openUntil && Date.now() < s.openUntil) return true;
  if (s.openUntil && Date.now() >= s.openUntil) {
    // cool-down period passed — reset and give it another chance
    s.openUntil = null;
    s.failures = [];
  }
  return false;
};

const recordFailure = (platformKey) => {
  const s = getState(platformKey);
  pruneOldFailures(s);
  s.failures.push(Date.now());

  if (s.failures.length >= FAILURE_THRESHOLD && !s.openUntil) {
    s.openUntil = Date.now() + OPEN_DURATION_MS;
    console.warn(
      `[CircuitBreaker] ${platformKey} tripped — ${s.failures.length} failures in ${FAILURE_WINDOW_MS / 1000}s. ` +
      `Blocking new ${platformKey} requests for ${OPEN_DURATION_MS / 1000}s.`
    );
  }
};

const recordSuccess = (platformKey) => {
  // A success is a good sign — trim the failure history so a couple of old
  // failures don't linger and contribute to a future trip.
  const s = getState(platformKey);
  pruneOldFailures(s);
  if (s.failures.length > 0) s.failures.shift();
};

/**
 * For the /health endpoint — snapshot of every platform's current state.
 */
const getStates = () => {
  const snapshot = {};
  for (const [platformKey, s] of state.entries()) {
    pruneOldFailures(s);
    snapshot[platformKey] = {
      recentFailures: s.failures.length,
      open: !!(s.openUntil && Date.now() < s.openUntil),
      openUntil: s.openUntil,
    };
  }
  return snapshot;
};

/**
 * Derives a stable platform key from the detectPlatform() flags object.
 */
const getPlatformKey = (platform) => {
  if (platform.isYouTube) return 'youtube';
  if (platform.isInstagram) return 'instagram';
  if (platform.isFacebook) return 'facebook';
  if (platform.isTikTok) return 'tiktok';
  if (platform.isTwitter) return 'twitter';
  return 'generic';
};

module.exports = { isOpen, recordFailure, recordSuccess, getStates, getPlatformKey };