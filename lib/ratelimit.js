// lib/ratelimit.js
// An audit is expensive and outbound: one request fans out into ~8 connections
// to a third-party host. Unmetered, a public deployment is both a free proxy and
// an amplifier that attacks other people from your IP.
//
// Three limits, because they fail differently:
//   requests per window  — stops sustained abuse from one caller
//   in-flight per caller — stops one caller queueing dozens of slow audits
//   in-flight globally   — stops the process running out of sockets/memory
//
// In-memory, so counters reset on deploy and are per-instance. That is the right
// trade for a single small service; put Redis behind it only if you scale out.

const DEFAULTS = {
  windowMs: 5 * 60 * 1000,
  max: 20,
  maxConcurrentPerClient: 2,
  maxConcurrentGlobal: 8,
  maxTrackedClients: 10_000,
};

export function createRateLimiter(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const clients = new Map();
  let globalActive = 0;

  function entryFor(key, now) {
    let entry = clients.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, active: entry?.active ?? 0, resetAt: now + config.windowMs };
      clients.set(key, entry);
    }
    return entry;
  }

  // Bound memory: drop the oldest expired entries once the map gets large.
  function sweep(now) {
    if (clients.size <= config.maxTrackedClients) return;
    for (const [key, entry] of clients) {
      if (now >= entry.resetAt && entry.active === 0) clients.delete(key);
      if (clients.size <= config.maxTrackedClients * 0.9) break;
    }
  }

  function middleware(req, res, next) {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const entry = entryFor(key, now);
    sweep(now);

    const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    const publishRemaining = () => res.setHeader('RateLimit-Remaining', Math.max(0, config.max - entry.count));
    res.setHeader('RateLimit-Limit', config.max);
    res.setHeader('RateLimit-Reset', resetSeconds);
    publishRemaining();

    if (globalActive >= config.maxConcurrentGlobal) {
      res.setHeader('Retry-After', 10);
      return res.status(503).json({ error: 'The checker is busy running other audits. Try again in a few seconds.' });
    }

    if (entry.active >= config.maxConcurrentPerClient) {
      res.setHeader('Retry-After', 5);
      return res.status(429).json({ error: 'You already have an audit running. Wait for it to finish before starting another.' });
    }

    if (entry.count >= config.max) {
      res.setHeader('Retry-After', resetSeconds);
      return res.status(429).json({
        error: `Rate limit reached (${config.max} audits per ${plural(Math.round(config.windowMs / 60000), 'minute')}). Try again in ${plural(Math.ceil(resetSeconds / 60), 'minute')}.`,
      });
    }

    entry.count++;
    entry.active++;
    globalActive++;
    publishRemaining();

    // 'close' covers aborted connections that never emit 'finish'.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.active = Math.max(0, entry.active - 1);
      globalActive = Math.max(0, globalActive - 1);
    };
    res.on('finish', release);
    res.on('close', release);

    next();
  }

  middleware.stats = () => ({ trackedClients: clients.size, globalActive });
  return middleware;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
