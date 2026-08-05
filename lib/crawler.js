// lib/crawler.js
// Walks a site and audits every page it finds, then reports the problems that
// are invisible from a single page: duplicate titles, duplicate content, orphans,
// broken internal targets, and how quality is distributed across the site.
//
// Discovery uses two sources. Breadth-first from the seed URL establishes click
// depth and inbound links; the XML sitemap fills in pages nothing links to,
// which is exactly how orphans surface — a URL the sitemap advertises but no
// crawled page links to.

import crypto from 'node:crypto';
import { analyze, buildSiteContext, normalizeUrl } from '../analyzer.js';
import { fetchPage } from './http.js';
import { robotsDisallows } from './robots.js';
import { IMPORTANCE, CATEGORY_SETS } from './checks.js';

const NON_HTML = /\.(jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|xml|txt|pdf|zip|gz|rar|mp[34]|m4a|mov|avi|webm|woff2?|ttf|eot|otf|dmg|exe|csv|xlsx?|docx?|pptx?)$/i;
const TRACKING_PARAM = /^(utm_|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|ref)$/i;

const DEFAULTS = {
  maxPages: 25,
  maxDepth: 4,
  concurrency: 4,
  // Sized for the largest crawl the UI offers: 100 pages at four at a time needs
  // roughly 5s per page of slack, which covers everything but a badly slow host.
  // A crawl that runs out of budget stops and reports stoppedEarly rather than
  // pretending it saw the whole site.
  timeBudgetMs: 300_000,
};

/**
 * Canonical form for de-duplication: drop the fragment and tracking params,
 * lowercase the host, and treat "/path" and "/path/" as the same page.
 */
export function canonicalizeUrl(input, base) {
  let url;
  try { url = new URL(input, base); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  return url.href;
}

const sameSite = (a, b) => a.replace(/^www\./, '') === b.replace(/^www\./, '');

/**
 * Crawl and audit a site.
 * @param {string} seedUrl
 * @param {{maxPages?:number, maxDepth?:number, concurrency?:number,
 *          timeBudgetMs?:number, onProgress?:Function, signal?:AbortSignal}} opts
 */
export async function crawlSite(seedUrl, opts = {}) {
  const config = { ...DEFAULTS, ...opts };
  const { onProgress, signal } = config;
  const mode = config.mode === 'geo' ? 'geo' : 'seo';
  const startedAt = Date.now();
  const deadline = startedAt + config.timeBudgetMs;

  // Resolve where the seed actually lands before anything else. A seed of
  // "example.com" that redirects to "www.example.com" would otherwise anchor the
  // whole crawl to an origin none of its pages belong to, so every URL would
  // render as absolute and the site identity would disagree with its own pages.
  const requestedSeed = normalizeUrl(seedUrl);
  const probeSeed = await fetchPage(requestedSeed.href, { maxBytes: 2048 });
  const seed = new URL(probeSeed.redirectChain[probeSeed.redirectChain.length - 1].url);

  const site = await buildSiteContext(seed);
  const origin = new URL(site.origin);

  const linkQueue = [];        // breadth-first, carries real click depth
  const seen = new Set();      // queued at least once
  const auditedUrls = new Set(); // audited, keyed by final destination
  const inbound = new Map();   // canonical url -> Set(pages linking to it)
  const pages = [];
  const failures = [];

  const crawlable = (url) => {
    const parsed = new URL(url);
    if (!sameSite(parsed.hostname, origin.hostname)) return false;
    if (NON_HTML.test(parsed.pathname)) return false;
    if (site.robots.found && robotsDisallows(site.robots.text, parsed.pathname + parsed.search)) return false;
    return true;
  };

  const enqueue = (rawUrl, depth) => {
    const url = canonicalizeUrl(rawUrl, origin);
    if (!url || seen.has(url) || !crawlable(url)) return;
    seen.add(url);
    linkQueue.push({ url, depth, source: depth === 0 ? 'seed' : 'link' });
  };

  enqueue(seed.href, 0);

  // Sitemap URLs are held back rather than queued up front: letting them in
  // early starves the breadth-first walk, and then no page ever gets a real
  // click depth. They fill whatever budget the link graph leaves over.
  const sitemapUrls = (site.sitemap.urls || [])
    .map((u) => canonicalizeUrl(u, origin))
    .filter((u) => u && sameSite(new URL(u).hostname, origin.hostname));
  const sitemapPending = [...sitemapUrls];

  const report = () => onProgress?.({
    crawled: pages.length + failures.length,
    discovered: seen.size + sitemapPending.length,
    queued: linkQueue.length,
    target: config.maxPages,
  });
  report();

  // ---- worker pool over a queue that grows while it drains -----------------
  let busy = 0;
  let claimed = 0; // reserved before visiting, so N workers cannot overshoot maxPages

  function takeNext() {
    if (claimed >= config.maxPages) return null;

    let item = linkQueue.shift() || null;
    while (!item && sitemapPending.length) {
      const url = sitemapPending.shift();
      if (seen.has(url) || !crawlable(url)) continue;
      seen.add(url);
      item = { url, depth: null, source: 'sitemap' };
    }

    if (item) claimed++;
    return item;
  }

  async function visit(item) {
    const audited = await analyze(item.url, { site, mode });

    // Identify the page by where it actually landed. Without this a seed like
    // "example.com" that 301s to "www.example.com" is audited twice and shows up
    // as a duplicate title, description, H1 and body — four phantom findings.
    // The claim has to be unconditional: two queue entries can resolve to the
    // same destination from different directions.
    const finalUrl = audited.page.url;
    const identity = canonicalizeUrl(finalUrl, origin) || item.url;
    if (auditedUrls.has(identity)) return false; // caller releases the reserved slot
    auditedUrls.add(identity);
    seen.add(identity);

    const words = audited.page.wordCount;
    pages.push({
      url: identity,
      requestedUrl: identity === item.url ? null : item.url,
      finalUrl,
      depth: item.depth,
      source: item.source,
      status: audited.page.statusCode,
      score: audited.score.overall,
      verdict: audited.score.verdict,
      errors: audited.score.errors,
      warnings: audited.score.warnings,
      title: audited.page.title,
      description: audited.page.description,
      h1: audited.elements.headings.list.find((h) => h.level === 1)?.text || null,
      wordCount: words,
      responseMs: audited.page.responseMs,
      sizeKb: audited.page.fileSizeKb,
      index: audited.page.pageStatus.index,
      canonical: audited.page.canonical,
      redirectHops: audited.page.redirectChain.length - 1,
      redirectFrom: audited.page.redirectChain[0]?.url || item.url,
      internalLinks: audited.elements.internalLinks.count,
      externalLinks: audited.elements.externalLinks.count,
      contentHash: words >= 50 ? hashText(audited.page.title, words, audited.elements.paragraphs.list) : null,
      categories: Object.fromEntries(audited.categories.filter((c) => c.measured).map((c) => [c.key, c.score])),
      todos: audited.todos.map((t) => ({ check: t.check, category: t.category, action: t.action, importance: t.importance })),
    });

    // Record the link graph, and queue anything new one level deeper. Pages
    // pulled from the sitemap have no click depth of their own, so anything they
    // link to is treated as depth 1.
    const nextDepth = item.depth === null ? 1 : item.depth + 1;
    for (const link of audited.elements.internalLinks.list) {
      const target = canonicalizeUrl(link.href, origin);
      if (!target) continue;
      if (!inbound.has(target)) inbound.set(target, new Set());
      inbound.get(target).add(identity);
      if (nextDepth <= config.maxDepth) enqueue(target, nextDepth);
    }
    return true;
  }

  async function worker() {
    while (true) {
      if (signal?.aborted) return;
      if (Date.now() > deadline) return;

      const item = takeNext();
      if (!item) {
        if (busy === 0) return;            // queue empty and nobody can refill it
        await sleep(60);
        continue;
      }

      busy++;
      try {
        // A page that turned out to be one already audited frees its reservation
        // so the budget is spent on a page we have not seen.
        if (!(await visit(item))) claimed--;
      } catch (err) {
        failures.push({ url: item.url, depth: item.depth, source: item.source, error: err.message });
      } finally {
        busy--;
        report();
      }
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, worker));

  pages.sort((a, b) => a.url.localeCompare(b.url));

  return {
    mode,
    seedUrl: seed.href,
    requestedUrl: requestedSeed.href,
    origin: site.origin,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    crawl: {
      requested: config.maxPages,
      crawled: pages.length,
      failed: failures.length,
      discovered: seen.size,
      notVisited: Math.max(0, seen.size - pages.length - failures.length),
      maxDepth: config.maxDepth,
      stoppedEarly: Date.now() > deadline || Boolean(signal?.aborted),
      sitemapUrls: sitemapUrls.length,
      robotsFound: site.robots.found,
      sitemapFound: site.sitemap.found,
    },
    // Origin-level field data, fetched once for the whole crawl.
    vitals: site.originVitals,
    ...summarize(pages, { inbound, sitemapUrls, failures, mode }),
    failures,
  };
}

// ---------------------------------------------------------------------------
// Cross-page analysis — the part a single-page audit structurally cannot do
// ---------------------------------------------------------------------------

function summarize(pages, { inbound, sitemapUrls, failures, mode = 'seo' }) {
  const scored = pages.filter((p) => typeof p.score === 'number');
  const overall = scored.length ? Math.round(scored.reduce((sum, p) => sum + p.score, 0) / scored.length) : 0;

  // Category averages across every page that produced a score, using whichever
  // ruleset the crawl ran under.
  const categories = CATEGORY_SETS[mode].map(({ key, label, weight }) => {
    const values = pages.map((p) => p.categories[key]).filter((v) => typeof v === 'number');
    return {
      key,
      label,
      weight,
      measured: values.length > 0,
      score: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null,
      pages: values.length,
    };
  });

  const duplicateTitles = groupDuplicates(pages, (p) => p.title);
  const duplicateDescriptions = groupDuplicates(pages, (p) => p.description);
  const duplicateH1s = groupDuplicates(pages, (p) => p.h1);
  const duplicateContent = groupDuplicates(pages, (p) => p.contentHash, (group) => group[0].title || group[0].url);

  const linkedUrls = new Set(inbound.keys());
  const crawledUrls = new Set(pages.map((p) => p.url));

  const issues = {
    duplicateTitles,
    duplicateDescriptions,
    duplicateH1s,
    duplicateContent,
    missingTitles: pages.filter((p) => !p.title).map((p) => p.url),
    missingDescriptions: pages.filter((p) => !p.description).map((p) => p.url),
    missingH1s: pages.filter((p) => !p.h1).map((p) => p.url),
    brokenPages: pages
      .filter((p) => p.status >= 400)
      .map((p) => ({ url: p.url, status: p.status, linkedFrom: [...(inbound.get(p.url) || [])].slice(0, 5) })),
    redirectingPages: pages.filter((p) => p.redirectHops > 0).map((p) => ({ from: p.redirectFrom, to: p.finalUrl, hops: p.redirectHops })),
    noindexPages: pages.filter((p) => !p.index).map((p) => p.url),
    thinPages: pages.filter((p) => p.wordCount < 300).map((p) => ({ url: p.url, wordCount: p.wordCount })).sort((a, b) => a.wordCount - b.wordCount),
    deepPages: pages.filter((p) => typeof p.depth === 'number' && p.depth > 3).map((p) => ({ url: p.url, depth: p.depth })),
    // A sitemap URL that no crawled page links to is a page users cannot reach
    // by navigating — search engines treat it as low priority for the same reason.
    orphanCandidates: sitemapUrls.filter((u) => !linkedUrls.has(u) && crawledUrls.has(u)),
    slowPages: pages.filter((p) => p.responseMs > 800).map((p) => ({ url: p.url, responseMs: p.responseMs })).sort((a, b) => b.responseMs - a.responseMs),
    unreachable: failures.map((f) => ({ url: f.url, error: f.error })),
  };

  return {
    score: {
      overall,
      verdict: verdictFor(overall),
      pagesScored: scored.length,
      best: scored.length ? Math.max(...scored.map((p) => p.score)) : null,
      worst: scored.length ? Math.min(...scored.map((p) => p.score)) : null,
      errors: pages.reduce((n, p) => n + p.errors, 0),
      warnings: pages.reduce((n, p) => n + p.warnings, 0),
      distribution: {
        strong: scored.filter((p) => p.score >= 80).length,
        fair: scored.filter((p) => p.score >= 60 && p.score < 80).length,
        weak: scored.filter((p) => p.score < 60).length,
      },
    },
    categories,
    issues,
    todos: aggregateTodos(pages),
    pages,
  };
}

/** Group pages sharing a non-empty value, returning only the collisions. */
function groupDuplicates(pages, pick, labelFor) {
  const groups = new Map();
  for (const page of pages) {
    const raw = pick(page);
    if (!raw) continue;
    const key = String(raw).trim().toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(page);
  }

  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      value: labelFor ? labelFor(group) : String(pick(group[0])).trim(),
      count: group.length,
      urls: group.map((p) => p.url),
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Roll page-level to-dos up to the site. One page needing 300 more words is a
 * task; forty pages needing it is a content strategy problem, and the count is
 * what tells them apart.
 */
function aggregateTodos(pages) {
  const groups = new Map();

  for (const page of pages) {
    for (const todo of page.todos) {
      const key = `${todo.category}›${todo.check}`;
      if (!groups.has(key)) {
        groups.set(key, { check: todo.check, category: todo.category, importance: todo.importance, pages: new Map(), actions: new Map() });
      }
      const group = groups.get(key);
      // Keyed by URL rather than collected in a Set, because the per-page
      // wording is the part you act on: "trim the meta description by 12
      // characters" reads very differently on the page that needs forty.
      if (!group.pages.has(page.url)) group.pages.set(page.url, todo.action);
      group.actions.set(todo.action, (group.actions.get(todo.action) || 0) + 1);
      if (IMPORTANCE[todo.importance].rank < IMPORTANCE[group.importance].rank) group.importance = todo.importance;
    }
  }

  return [...groups.values()]
    .map((group) => {
      // The most frequently produced wording is the most representative fix.
      const action = [...group.actions.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return {
        check: group.check,
        category: group.category,
        importance: group.importance,
        importanceLabel: IMPORTANCE[group.importance].label,
        pageCount: group.pages.size,
        // Every affected page, so "15 pages need a meta description" can say
        // which fifteen. Replaces sampleUrls, which capped at five and was
        // never rendered anywhere. `action` is carried only where it differs
        // from the group wording above — on checks that say the same thing
        // everywhere, that is most of the payload saved.
        pages: [...group.pages.entries()].map(([url, pageAction]) =>
          pageAction === action ? { url } : { url, action: pageAction }),
        action,
      };
    })
    .sort((a, b) => {
      const rank = IMPORTANCE[a.importance].rank - IMPORTANCE[b.importance].rank;
      return rank !== 0 ? rank : b.pageCount - a.pageCount;
    });
}

function hashText(title, words, paragraphs) {
  return crypto.createHash('sha1')
    .update(`${words}|${paragraphs.join(' ').replace(/\s+/g, ' ').toLowerCase().slice(0, 4000)}`)
    .digest('hex')
    .slice(0, 16);
}

function verdictFor(score) {
  if (score >= 90) return 'Very good';
  if (score >= 80) return 'Good';
  if (score >= 60) return 'Warning';
  if (score >= 40) return 'Poor';
  return 'Critical';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
