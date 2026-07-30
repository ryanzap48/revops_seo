// server.js
import express from 'express';
import { analyze } from './analyzer.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRateLimiter } from './lib/ratelimit.js';
import { privateHostsAllowed } from './lib/guard.js';
import { crawlSite } from './lib/crawler.js';
import { createJobStore } from './lib/jobs.js';

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

// A crawl is one request that becomes dozens of page audits, so it gets its own,
// much tighter quota. Concurrency is enforced separately below, against running
// jobs rather than open connections — the HTTP response returns immediately.
const crawlLimiter = createRateLimiter({
  windowMs: Number(process.env.CRAWL_RATE_LIMIT_WINDOW_MS ?? 15 * 60 * 1000),
  max: Number(process.env.CRAWL_RATE_LIMIT_MAX ?? 3),
  maxConcurrentPerClient: 1,
  maxConcurrentGlobal: 4,
});

const MAX_CRAWL_PAGES = Number(process.env.MAX_CRAWL_PAGES ?? 100);
const MAX_CONCURRENT_CRAWLS = Number(process.env.MAX_CONCURRENT_CRAWLS ?? 2);
const jobs = createJobStore();

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

// ---- Site crawl: start a job, then poll it --------------------------------

app.post('/api/crawl', crawlLimiter, (req, res) => {
  const url = req.body?.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Please provide a URL to crawl.' });
  }

  const requested = Number(req.body?.maxPages ?? 25);
  const maxPages = Math.min(MAX_CRAWL_PAGES, Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 25));

  const ownerKey = req.ip || 'unknown';
  if (jobs.activeCountFor(ownerKey) > 0) {
    return res.status(429).json({ error: 'You already have a crawl running. Wait for it to finish before starting another.' });
  }
  if (jobs.activeCount() >= MAX_CONCURRENT_CRAWLS) {
    res.setHeader('Retry-After', 30);
    return res.status(503).json({ error: 'Another site crawl is already running. Try again shortly.' });
  }

  const job = jobs.create(ownerKey, { url, maxPages });
  res.status(202).json({ jobId: job.id, status: job.status, maxPages });

  // Runs past the lifetime of this response; the client polls for progress.
  crawlSite(url, {
    maxPages,
    onProgress: (progress) => jobs.update(job.id, { progress }),
  })
    .then((result) => {
      jobs.update(job.id, { status: 'done', result });
      console.log(`crawled ${result.origin} → ${result.crawl.crawled} pages, ${result.score.overall}% in ${result.durationMs} ms`);
    })
    .catch((err) => {
      const message = err.blocked ? err.message : `Crawl failed: ${err.message}`;
      jobs.update(job.id, { status: 'error', error: message });
      console.error('Crawl error:', err.message);
    });
});

app.get('/api/crawl/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'That crawl has expired or never existed.' });
  res.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    result: job.status === 'done' ? job.result : null,
  });
});

app.get('/health', (_req, res) => res.json({ ok: true, ...limiter.stats(), jobs: jobs.size(), crawlsRunning: jobs.activeCount() }));

app.listen(PORT, () => {
  console.log(`RevOps SEO running at http://localhost:${PORT}`);
  if (privateHostsAllowed) {
    console.warn('WARNING: ALLOW_PRIVATE_HOSTS=true — private and loopback addresses are reachable. Never set this in production.');
  }
});
