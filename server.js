// server.js
import express from 'express';
import { analyze } from './analyzer.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

async function handleAnalyze(url, res) {
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Please provide a URL to analyze.' });
  }
  try {
    const started = Date.now();
    const report = await analyze(url);
    console.log(`analyzed ${report.page.url} → ${report.score.overall}% in ${Date.now() - started} ms`);
    res.json(report);
  } catch (err) {
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

app.post('/api/analyze', (req, res) => handleAnalyze(req.body?.url, res));
app.get('/api/analyze', (req, res) => handleAnalyze(req.query.url, res));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`RevOps SEO running at http://localhost:${PORT}`);
});
