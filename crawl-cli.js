// crawl-cli.js
// Headless entry point into the same crawl the web UI runs, for callers that
// want the JSON and nothing else — the weekly PDF report, mainly.
//
//   node crawl-cli.js --url revops.health --mode seo --max-pages 100 --out seo.json
//
// Progress goes to stderr so stdout stays a single clean JSON document when no
// --out is given.

import { writeFileSync } from 'node:fs';
import { crawlSite } from './lib/crawler.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const url = args.url || args._;
if (!url || url === true) {
  console.error('Usage: node crawl-cli.js --url <site> [--mode seo|geo] [--max-pages 100] [--out file.json]');
  process.exit(2);
}

const mode = String(args.mode || 'seo').toLowerCase() === 'geo' ? 'geo' : 'seo';
const maxPages = Math.max(1, Math.min(500, Number(args['max-pages'] ?? 100) || 100));
// A 100-page crawl finishes in seconds against a healthy host, but the PDF job
// runs unattended, so the budget is generous rather than tight.
const timeBudgetMs = Number(args['time-budget-ms'] ?? 600_000);

let lastReport = 0;
try {
  const result = await crawlSite(url, {
    mode,
    maxPages,
    timeBudgetMs,
    onProgress: (p) => {
      // Throttled: the crawler reports after every page finishes.
      if (Date.now() - lastReport < 1000) return;
      lastReport = Date.now();
      process.stderr.write(`[${mode}] ${p.crawled}/${p.target} crawled, ${p.discovered} discovered\n`);
    },
  });

  const json = JSON.stringify(result);
  if (args.out && args.out !== true) {
    writeFileSync(args.out, json);
    process.stderr.write(`[${mode}] wrote ${args.out} — ${result.crawl.crawled} pages, ${result.score.overall}%\n`);
  } else {
    process.stdout.write(json);
  }
} catch (err) {
  console.error(`Crawl failed: ${err.message}`);
  process.exit(1);
}
