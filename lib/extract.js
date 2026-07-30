// lib/extract.js
// Turns raw HTML into a structured document model. Everything the checks and the
// Elements view need is pulled out exactly once here, so no check re-parses the
// DOM and the Elements tab is guaranteed to show the same data the score is
// based on.

import * as cheerio from 'cheerio';
import { tokenize, splitSentences, stopWordRatio, detectLanguage, findTextIssues } from './text.js';

const PLACEHOLDER_TEXT = /\b(lorem ipsum|dolor sit amet|dummy text|placeholder text|your text here|insert text here|sample text|text goes here|coming soon)\b/i;
const PLACEHOLDER_SRC = /(placehold|dummy|lorem|sample-image|no-image|default-thumb)/i;

const SOCIAL_HOSTS = [
  'facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'instagram.com',
  'youtube.com', 'youtu.be', 'tiktok.com', 'pinterest.com', 'threads.net',
  'reddit.com', 'mastodon.social', 'bsky.app', 'github.com',
];
const SHARE_PATTERNS = /(sharer\.php|share_url|twitter\.com\/intent|linkedin\.com\/share|pinterest\.com\/pin\/create|addtoany|sharethis|reddit\.com\/submit|mailto:\?subject)/i;

const TRACKING_PARAMS = /^(utm_|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|ref|referrer)/i;
const SESSION_PARAMS = /^(sid|sessionid|session_id|phpsessid|jsessionid|aspsessionid|zenid)$/i;

export function extract(html, pageUrl, headers = {}) {
  const $ = cheerio.load(html);
  const base = new URL(pageUrl);

  // ---- Head-level metadata ------------------------------------------------
  const title = clean($('head title').first().text() || $('title').first().text());

  const metaTags = [];
  $('meta').each((_, el) => {
    const attrs = $(el).attr() || {};
    const name = attrs.name || attrs.property || attrs['http-equiv'] || (attrs.charset != null ? 'charset' : null) || attrs.itemprop || '(unnamed)';
    const content = attrs.content ?? attrs.charset ?? '';
    metaTags.push({ name, content: clean(content), kind: attrs.property ? 'property' : attrs['http-equiv'] ? 'http-equiv' : 'name' });
  });

  const meta = (selector) => clean($(selector).first().attr('content') || '');
  const description = meta('meta[name="description"]') || meta('meta[property="og:description"][data-fallback]');
  const robotsMeta = (meta('meta[name="robots"]') || meta('meta[name="googlebot"]')).toLowerCase();
  const xRobots = String(headers['x-robots-tag'] || '').toLowerCase();
  const viewport = meta('meta[name="viewport"]');
  const author = meta('meta[name="author"]');
  const generator = meta('meta[name="generator"]');
  const refresh = meta('meta[http-equiv="refresh"]');
  const relNext = $('link[rel="next"]').attr('href') || null;
  const relPrev = $('link[rel="prev"]').attr('href') || null;

  const canonicalRaw = $('link[rel="canonical"]').first().attr('href') || null;
  let canonical = null;
  let canonicalAbsolute = false;
  let canonicalSelf = false;
  if (canonicalRaw) {
    try {
      const abs = new URL(canonicalRaw, base);
      canonical = abs.href;
      canonicalAbsolute = /^https?:\/\//i.test(canonicalRaw.trim());
      canonicalSelf = stripHash(abs.href) === stripHash(base.href);
    } catch { canonical = canonicalRaw; }
  }

  const hreflang = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    hreflang.push({ lang: $(el).attr('hreflang'), href: $(el).attr('href') || '' });
  });

  const htmlLang = clean($('html').attr('lang') || '');
  const charsetMeta = $('meta[charset]').attr('charset') || null;
  const charsetHeader = (String(headers['content-type'] || '').match(/charset=([\w-]+)/i) || [])[1] || null;
  const charset = (charsetMeta || charsetHeader || '').toUpperCase() || null;

  const favicons = [];
  $('link[rel]').each((_, el) => {
    const rel = String($(el).attr('rel') || '').toLowerCase();
    if (!/icon/.test(rel)) return;
    favicons.push({ rel, href: $(el).attr('href') || '', sizes: $(el).attr('sizes') || null });
  });
  const appleTouchIcons = favicons.filter((f) => f.rel.includes('apple-touch-icon'));

  // ---- Doctype ------------------------------------------------------------
  const doctypeMatch = html.match(/<!doctype[^>]*>/i);
  const beforeDoctype = doctypeMatch ? html.slice(0, doctypeMatch.index) : '';
  const doctype = {
    present: Boolean(doctypeMatch),
    raw: doctypeMatch ? doctypeMatch[0].replace(/\s+/g, ' ').trim() : null,
    html5: doctypeMatch ? /^<!doctype\s+html\s*>$/i.test(doctypeMatch[0].replace(/\s+/g, ' ').trim()) : false,
    first: doctypeMatch ? beforeDoctype.replace(/<!--[\s\S]*?-->/g, '').replace(/^﻿/, '').trim() === '' : false,
  };

  // ---- Headings -----------------------------------------------------------
  const headings = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    headings.push({
      level: Number(el.tagName.slice(1)),
      text: clean($(el).text()),
    });
  });
  const h1s = headings.filter((h) => h.level === 1);

  // Skipped levels: a heading more than one level below its predecessor.
  const skipped = [];
  let previous = 0;
  for (const h of headings) {
    if (previous && h.level > previous + 1) skipped.push({ from: previous, to: h.level, text: h.text });
    previous = h.level;
  }

  // ---- Visible text -------------------------------------------------------
  const $text = cheerio.load(html);
  $text('script, style, noscript, template, svg, iframe, object, canvas, [aria-hidden="true"], [hidden]').remove();
  const bodyText = clean($text('body').text().replace(/\s+/g, ' '));

  const mainScope = $text('main').length ? $text('main') : $text('article').length ? $text('article') : null;
  const mainText = mainScope ? clean(mainScope.text().replace(/\s+/g, ' ')) : bodyText;

  const tokens = tokenize(bodyText);
  const sentences = splitSentences(mainText);

  // ---- Paragraphs / text blocks ------------------------------------------
  const paragraphs = [];
  $text('p, blockquote, dd, figcaption').each((_, el) => {
    const text = clean($text(el).text().replace(/\s+/g, ' '));
    if (tokenize(text).length >= 3) paragraphs.push(text);
  });
  // Text-bearing divs with no element children are paragraphs in practice.
  $text('div, section, td').each((_, el) => {
    if ($text(el).children().length) return;
    const text = clean($text(el).text().replace(/\s+/g, ' '));
    if (text.length >= 60 && tokenize(text).length >= 10) paragraphs.push(text);
  });

  const seenParagraph = new Map();
  for (const p of paragraphs) {
    const key = p.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
    seenParagraph.set(key, (seenParagraph.get(key) || 0) + 1);
  }
  const duplicateParagraphs = [...seenParagraph.entries()].filter(([, n]) => n > 1).length;

  // ---- Emphasis -----------------------------------------------------------
  const bold = [];
  $text('strong, b').each((_, el) => {
    const text = clean($text(el).text().replace(/\s+/g, ' '));
    if (text) bold.push(text);
  });

  const lists = { ul: $text('ul').length, ol: $text('ol').length, dl: $text('dl').length };
  const tables = $text('table').length;

  // ---- Media --------------------------------------------------------------
  const media = [];
  $('img').each((_, el) => {
    const a = $(el).attr() || {};
    media.push({
      tag: 'img',
      src: resolve(a.src || a['data-src'] || (a.srcset || '').split(/\s*,\s*/)[0]?.split(/\s+/)[0], base),
      alt: a.alt != null ? clean(a.alt) : null,
      title: a.title ? clean(a.title) : null,
      width: a.width || null,
      height: a.height || null,
      loading: a.loading || null,
      decorative: a.alt === '' || a.role === 'presentation',
    });
  });
  $('video, audio, embed, object, source, track').each((_, el) => {
    const a = $(el).attr() || {};
    media.push({
      tag: el.tagName.toLowerCase(),
      src: resolve(a.src || a.data || a.srcset, base),
      alt: null, title: a.title ? clean(a.title) : null,
      width: a.width || null, height: a.height || null, loading: null, decorative: false,
    });
  });
  const inlineSvg = $('svg').length;
  const images = media.filter((m) => m.tag === 'img');
  const contentImages = images.filter((m) => !m.decorative);
  const imagesWithAlt = images.filter((m) => m.alt != null && m.alt.trim() !== '');
  const imagesMissingAlt = images.filter((m) => m.alt == null);
  const lazyImages = images.filter((m) => m.loading === 'lazy');
  const sizedImages = images.filter((m) => m.width && m.height);

  // ---- Links --------------------------------------------------------------
  const internal = [];
  const external = [];
  const anchorless = [];
  const fragments = [];
  const mailtoTel = [];

  $('a').each((_, el) => {
    const $el = $(el);
    const href = ($el.attr('href') || '').trim();
    const rel = String($el.attr('rel') || '').toLowerCase();
    const anchor = clean($el.text().replace(/\s+/g, ' ')) ||
      clean($el.find('img[alt]').first().attr('alt') || '') ||
      clean($el.attr('aria-label') || '') ||
      clean($el.attr('title') || '');

    if (!href) return;
    if (/^(mailto:|tel:|sms:|callto:)/i.test(href)) { mailtoTel.push({ href, anchor }); return; }
    if (href.startsWith('#')) { fragments.push({ href, anchor }); return; }
    if (/^(javascript:|data:)/i.test(href)) return;

    let abs;
    try { abs = new URL(href, base); } catch { return; }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;

    const record = {
      href: abs.href,
      anchor,
      hasAnchorText: Boolean(anchor),
      nofollow: /\bnofollow\b/.test(rel),
      rel: rel || null,
      target: $el.attr('target') || null,
      params: [...abs.searchParams.keys()],
    };

    if (sameSite(abs.hostname, base.hostname)) internal.push(record);
    else external.push(record);
    if (!anchor) anchorless.push(record);
  });

  const anchorCounts = new Map();
  for (const l of internal) {
    if (!l.anchor) continue;
    const key = l.anchor.toLowerCase();
    const entry = anchorCounts.get(key) || { anchor: l.anchor, count: 0, targets: new Set() };
    entry.count++;
    entry.targets.add(stripHash(l.href));
    anchorCounts.set(key, entry);
  }
  // Only a problem when the same words point at *different* pages.
  const duplicateAnchors = [...anchorCounts.values()]
    .filter((e) => e.count > 1 && e.targets.size > 1)
    .map((e) => ({ anchor: e.anchor, count: e.count, targets: e.targets.size }))
    .sort((a, b) => b.count - a.count);

  const longAnchors = [...internal, ...external].filter((l) => l.anchor.length > 100);
  const dynamicInternal = internal.filter((l) => l.params.some((p) => !TRACKING_PARAMS.test(p)));
  const sessionLinks = internal.filter((l) => l.params.some((p) => SESSION_PARAMS.test(p)));
  const unsafeTargets = external.filter((l) => l.target === '_blank' && !/\b(noopener|noreferrer)\b/.test(l.rel || ''));

  // ---- Structured data, social, security ---------------------------------
  const jsonLd = [];
  const jsonLdErrors = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    try {
      const parsed = JSON.parse(raw);
      for (const node of flattenGraph(parsed)) {
        const type = node['@type'];
        if (type) jsonLd.push(Array.isArray(type) ? type.join(' / ') : String(type));
      }
    } catch {
      jsonLdErrors.push(clean(raw).slice(0, 120));
    }
  });

  const microdata = $('[itemscope]').length;
  const rdfa = $('[vocab], [typeof], [property]').length;
  const microformats = $('[class*="h-card"], [class*="h-entry"]').length;

  const socialProfiles = [];
  const shareLinks = [];
  for (const l of external) {
    const host = safeHost(l.href);
    if (SOCIAL_HOSTS.some((s) => host === s || host.endsWith(`.${s}`))) socialProfiles.push(l.href);
    if (SHARE_PATTERNS.test(l.href)) shareLinks.push(l.href);
  }
  const shareWidgets = $('[class*="share"], [class*="sharing"], [id*="share"], [data-share]').length;

  const insecure = [];
  if (base.protocol === 'https:') {
    $('[src], [href]').each((_, el) => {
      const tag = el.tagName.toLowerCase();
      if (!['script', 'img', 'link', 'iframe', 'source', 'video', 'audio', 'embed'].includes(tag)) return;
      const val = $(el).attr('src') || $(el).attr('href') || '';
      if (/^http:\/\//i.test(val)) insecure.push({ tag, url: val });
    });
  }

  const frames = { frameset: $('frameset').length, frame: $('frame').length, iframe: $('iframe').length };

  const openGraph = {
    title: meta('meta[property="og:title"]'),
    description: meta('meta[property="og:description"]'),
    image: meta('meta[property="og:image"]'),
    url: meta('meta[property="og:url"]'),
    type: meta('meta[property="og:type"]'),
    siteName: meta('meta[property="og:site_name"]'),
  };
  const twitter = {
    card: meta('meta[name="twitter:card"]'),
    title: meta('meta[name="twitter:title"]'),
    description: meta('meta[name="twitter:description"]'),
    image: meta('meta[name="twitter:image"]'),
  };

  const hasAuthorMarkup = Boolean(author) || $('[rel="author"], [itemprop="author"], [class*="author" i]').length > 0;
  const hasDateMarkup = $('time[datetime], [itemprop="datePublished"], meta[property="article:published_time"]').length > 0;

  return {
    $,
    title,
    description,
    metaTags,
    robotsMeta,
    xRobots,
    index: !/\bnoindex\b/.test(robotsMeta) && !/\bnoindex\b/.test(xRobots),
    follow: !/\bnofollow\b/.test(robotsMeta) && !/\bnofollow\b/.test(xRobots),
    viewport,
    author,
    generator,
    refresh,
    relNext,
    relPrev,
    canonical,
    canonicalRaw,
    canonicalAbsolute,
    canonicalSelf,
    hreflang,
    htmlLang,
    charset,
    charsetMeta,
    charsetHeader,
    favicons,
    appleTouchIcons,
    doctype,
    headings,
    h1s,
    skippedHeadingLevels: skipped,
    emptyHeadings: headings.filter((h) => !h.text).length,
    bodyText,
    mainText,
    tokens,
    wordCount: tokens.length,
    stopWordPct: stopWordRatio(tokens),
    sentences,
    avgSentenceWords: sentences.length ? tokenize(mainText).length / sentences.length : 0,
    paragraphs,
    duplicateParagraphs,
    textIssues: findTextIssues(paragraphs),
    language: detectLanguage(mainText),
    bold,
    lists,
    tables,
    media,
    images,
    contentImages,
    imagesWithAlt,
    imagesMissingAlt,
    lazyImages,
    sizedImages,
    inlineSvg,
    internal,
    external,
    anchorless,
    fragments,
    mailtoTel,
    duplicateAnchors,
    longAnchors,
    dynamicInternal,
    sessionLinks,
    unsafeTargets,
    jsonLd,
    jsonLdErrors,
    microdata,
    rdfa,
    microformats,
    socialProfiles: [...new Set(socialProfiles)],
    shareLinks: [...new Set(shareLinks)],
    shareWidgets,
    insecure,
    frames,
    openGraph,
    twitter,
    hasAuthorMarkup,
    hasDateMarkup,
    hasPlaceholderText: PLACEHOLDER_TEXT.test(bodyText),
    placeholderImages: images.filter((m) => m.src && PLACEHOLDER_SRC.test(m.src)).length,
  };
}

// ---- helpers ---------------------------------------------------------------

function clean(s) {
  return String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function stripHash(u) {
  return String(u).split('#')[0].replace(/\/$/, '');
}

function resolve(href, base) {
  if (!href) return null;
  try { return new URL(href, base).href; } catch { return href; }
}

function safeHost(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function sameSite(a, b) {
  const norm = (h) => h.toLowerCase().replace(/^www\./, '');
  return norm(a) === norm(b);
}

function flattenGraph(node, out = []) {
  if (Array.isArray(node)) {
    for (const n of node) flattenGraph(n, out);
  } else if (node && typeof node === 'object') {
    out.push(node);
    if (Array.isArray(node['@graph'])) for (const n of node['@graph']) flattenGraph(n, out);
  }
  return out;
}
