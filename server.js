// server.js
import express from 'express';
import { analyze } from './analyzer.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRateLimiter } from './lib/ratelimit.js';
import { privateHostsAllowed } from './lib/guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Render, Railway and Fly all put the app behind one proxy hop. Without this,
// req.ip is the proxy's address and every caller shares a single rate-limit
// bucket. Trusting exactly one hop means the client cannot forge its own IP by
// sending an X-Forwarded-For header.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
app.disable('x-powered-by');

const limiter = createRateLimiter({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 5 * 60 * 1000),
  max: Number(process.env.RATE_LIMIT_MAX ?? 20),
  maxConcurrentPerClient: Number(process.env.MAX_CONCURRENT_PER_CLIENT ?? 2),
  maxConcurrentGlobal: Number(process.env.MAX_CONCURRENT_GLOBAL ?? 8),
});

app.use(express.json({ limit: '8kb' }));
app.use(express.static(join(__dirname, 'public')));

async function handleAnalyze(url, res) {
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Please provide a URL to analyze.' });
  }
  if (url.length > 2048) {
    return res.status(400).json({ error: 'That URL is too long to be real.' });
  }

  try {
    const started = Date.now();
    const report = await analyze(url);
    console.log(`analyzed ${report.page.url} → ${report.score.overall}% in ${Date.now() - started} ms`);
    res.json(report);
  } catch (err) {
    // A blocked target is the caller's mistake (400), not a server failure.
    if (err.blocked) {
      console.warn(`blocked: ${url} — ${err.message}`);
      return res.status(400).json({ error: err.message });
    }

    console.error('Analysis error:', err.message);
    const message = /timed out/i.test(err.message)
      ? 'The site took too long to respond. It may be blocking automated requests.'
      : /ENOTFOUND|EAI_AGAIN/.test(err.message)
        ? 'That hostname could not be resolved. Check the spelling.'
        : /ECONNREFUSED|ECONNRESET|EPROTO|socket hang up/.test(err.message)
          ? 'The server refused the connection.'
          : err.message;
    res.status(/not a valid|provide a URL/i.test(message) ? 400 : 502).json({ error: message });
  }
}

app.post('/api/analyze', limiter, (req, res) => handleAnalyze(req.body?.url, res));
app.get('/api/analyze', limiter, (req, res) => handleAnalyze(req.query.url, res));

app.get('/health', (_req, res) => res.json({ ok: true, ...limiter.stats() }));

app.listen(PORT, () => {
  console.log(`RevOps SEO running at http://localhost:${PORT}`);
  if (privateHostsAllowed) {
    console.warn('WARNING: ALLOW_PRIVATE_HOSTS=true — private and loopback addresses are reachable. Never set this in production.');
  }
});
