// analyzer.js
// Orchestrates the audit: fetch the page and its supporting resources, build a
// document model, run every check, then assemble the score, the to-do list, the
// element inventory and the keyword table.
//
// Categories and weights live in lib/checks.js. Findings are one point each so
// that a "7/8" always maps to one identifiable line of text.

import { fetchPage, fetchRobots, fetchSitemap, probe, negotiatedProtocol, resolveHost } from './lib/http.js';
import { extract } from './lib/extract.js';
import { createAudit, verdict } from './lib/checks.js';
import { extractKeywords, tokenize, STOP_WORDS } from './lib/text.js';
import { titlePixels, descriptionPixels, TITLE_MAX_PX, DESC_MAX_PX } from './lib/pixels.js';
import { robotsDisallows } from './lib/robots.js';
import { fetchFieldData, fetchPageFieldData, cruxConfigured, THRESHOLDS } from './lib/vitals.js';

const KB = 1024;
const TRACKING_PARAM = /^(utm_|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga)/i;
const SESSION_PARAM = /^(sid|sessionid|session_id|phpsessid|jsessionid|aspsessionid|zenid)$/i;
const GENERIC_IMAGE_NAME = /\/(img|image|photo|pic|dsc|dcim|screen ?shot|screenshot|untitled|final|copy|asset|download)[-_ ]?\d*\.(jpe?g|png|webp|gif|avif)$/i;

/**
 * Fetch everything that describes the *site* rather than one page: robots.txt,
 * the sitemap, the TLS/ALPN handshake, DNS, and the www/HTTPS canonicalisation
 * probes. A crawl does this once and hands the result to every page audit,
 * which is the difference between ~8 requests per page and ~2.
 */
export async function buildSiteContext(originUrl) {
  const origin = new URL(originUrl);
  const isHttps = origin.protocol === 'https:';

  const [robots, transport, host] = await Promise.all([
    fetchRobots(origin.origin),
    isHttps ? negotiatedProtocol(origin.hostname) : Promise.resolve({ protocol: 'HTTP/1.1', alpn: null, tlsVersion: null }),
    resolveHost(origin.hostname),
  ]);

  const [sitemap, hostVariant, httpsRedirect, originVitals] = await Promise.all([
    fetchSitemap(robots.sitemaps?.[0] || `${origin.origin}/sitemap.xml`),
    checkHostVariant(origin),
    isHttps ? checkHttpUpgrade(origin) : Promise.resolve({ tested: false }),
    // Origin-level field data is the fallback for every page that is itself too
    // low-traffic to appear in CrUX, so a crawl fetches it once.
    cruxConfigured() ? fetchFieldData({ origin: origin.origin }) : Promise.resolve({ available: false, reason: 'no-key' }),
  ]);

  return {
    origin: origin.origin,
    robots, transport, host, sitemap, hostVariant, httpsRedirect, originVitals,
    faviconCache: new Map(),
  };
}

/**
 * Audit one page.
 * @param {string} inputUrl
 * @param {{site?: object}} [options] `site` reuses a context from
 *        buildSiteContext(); it is ignored if it belongs to a different origin.
 */
export async function analyze(inputUrl, options = {}) {
  const requested = normalizeUrl(inputUrl);

  const page = await fetchPage(requested.href);
  const finalUrl = new URL(page.redirectChain[page.redirectChain.length - 1].url);
  const html = decodeBody(page.body, page.headers);
  const doc = extract(html, finalUrl.href, page.headers);

  const site = options.site?.origin === finalUrl.origin ? options.site : await buildSiteContext(finalUrl);
  const { robots, transport, host, sitemap, hostVariant, httpsRedirect } = site;

  const [faviconCheck, vitals] = await Promise.all([
    checkFavicon(doc, finalUrl, site.faviconCache),
    options.skipVitals
      ? Promise.resolve({ available: false, reason: 'skipped' })
      : fetchPageFieldData(finalUrl.href, site.originVitals),
  ]);

  const htmlBytes = page.body.length;
  const audit = createAudit();

  runMetaChecks(audit, { doc, page, finalUrl, robots, faviconCheck, host, transport });
  runQualityChecks(audit, { doc, page, finalUrl, htmlBytes, transport });
  runStructureChecks(audit, { doc });
  runLinkChecks(audit, { doc });
  runServerChecks(audit, { doc, page, finalUrl, htmlBytes, robots, sitemap, transport, hostVariant, httpsRedirect });
  runVitalsChecks(audit, { vitals });
  runExternalChecks(audit, { doc });

  const scored = audit.finalize();

  // Keywords are read from the main content when the page marks one up, so
  // navigation and footer boilerplate does not distort the topic profile.
  const keywordScope = doc.mainText === doc.bodyText ? 'full page text' : 'main content';
  const keywords = extractKeywords(doc.mainText, {
    title: doc.title,
    description: doc.description,
    headings: doc.headings,
    url: finalUrl.href,
    limit: 25,
  });

  return {
    requestedUrl: requested.href,
    analyzedAt: new Date().toISOString(),

    score: {
      overall: scored.overall,
      verdict: verdict(scored.overall),
      grade: gradeFor(scored.overall),
      errors: scored.totals.errors,
      warnings: scored.totals.warnings,
      passed: scored.totals.passed,
      checks: scored.totals.checks,
      findings: scored.totals.findings,
    },

    page: {
      title: doc.title || null,
      description: doc.description || null,
      url: finalUrl.href,
      statusCode: page.status,
      statusText: page.statusMessage || '',
      pageStatus: { index: doc.index, follow: doc.follow, robotsMeta: doc.robotsMeta || null, xRobots: doc.xRobots || null },
      language: {
        detected: doc.language.code,
        detectedConfidence: Math.round(doc.language.confidence * 100),
        declared: doc.htmlLang || null,
      },
      responseMs: Math.round(page.ttfbMs),
      totalMs: Math.round(page.totalMs),
      fileSizeKb: round1(htmlBytes / KB),
      transferKb: round1(page.transferBytes / KB),
      compression: page.contentEncoding,
      wordCount: doc.wordCount,
      protocol: transport.protocol || `HTTP/${page.httpVersion}`,
      tlsVersion: transport.tlsVersion || null,
      certValidTo: transport.certValidTo || null,
      serverIp: host.ip,
      server: page.headers.server || null,
      contentType: page.headers['content-type'] || null,
      charset: doc.charset,
      redirectChain: page.redirectChain,
      canonical: doc.canonical,
    },

    vitals,
    categories: scored.categories,
    todos: scored.todos,
    elements: buildElements({ doc, page, transport, keywords, keywordScope }),
    keywords: keywords.list,
  };
}

// ---------------------------------------------------------------------------
// Meta data
// ---------------------------------------------------------------------------

function runMetaChecks(audit, { doc, page, finalUrl, robots, faviconCheck, host, transport }) {
  // ---- Title --------------------------------------------------------------
  const title = audit.check('meta', 'Title', 'critical', {
    value: doc.title || null,
    help: 'The title is the strongest on-page ranking signal and the headline of your search result.',
  });

  if (!doc.title) {
    title.fail('No page title was found. This is the single most important on-page element.', {
      todo: 'Add a unique <title> of roughly 50–60 characters with the primary keyword near the front.',
    });
  } else {
    const px = titlePixels(doc.title);
    if (px > TITLE_MAX_PX) {
      title.warn(`The page title is too long (${px} pixels out of ${TITLE_MAX_PX} max pixel length). It will be truncated in search results.`, {
        todo: `Shorten the page title by about ${Math.ceil((px - TITLE_MAX_PX) / 9)} characters so it is not cut off in the SERP.`,
      });
    } else if (px < TITLE_MAX_PX * 0.5) {
      title.warn(`The page title is too short (${px} pixels out of ${TITLE_MAX_PX} max pixel length). You are leaving SERP space unused.`, {
        todo: 'Expand the page title toward 500–580 pixels to add context and secondary keywords.',
      });
    } else {
      title.ok(`The length of the page title is perfect. (${px} pixels out of ${TITLE_MAX_PX} max pixel length)`);
    }

    const words = tokenize(doc.title).filter((w) => !STOP_WORDS.has(w));
    const dupes = duplicates(words);
    title.assert(
      dupes.length === 0,
      'There are no duplicate words in the title.',
      `The title contains repeated words: ${dupes.map((d) => `"${d}"`).join(', ')}.`,
      { todo: `Remove the repetition of ${dupes.map((d) => `"${d}"`).join(', ')} from the page title.` }
    );

    title.assert(
      words.length >= 3,
      `The title contains ${tokenize(doc.title).length} words, enough to describe the page.`,
      'The title is only a word or two long and does not describe the page.',
      { todo: 'Write a descriptive title of at least three meaningful words.' }
    );

    if (doc.title === doc.title.toUpperCase() && doc.title.length > 12) {
      title.warn('The title is written entirely in capitals, which reads as shouting in the SERP.', {
        todo: 'Rewrite the page title in sentence or title case instead of all capitals.',
      });
    }

    title.info('Each page on your site needs its own title — this check only sees the URL you submitted, so crawl the whole site to catch duplicates.');
  }

  // ---- Meta description ---------------------------------------------------
  const desc = audit.check('meta', 'Meta description', 'critical', {
    value: doc.description || null,
    help: 'The description does not rank the page, but it decides how many people click it.',
  });

  if (!doc.description) {
    desc.fail('No meta description was found. Google will invent a snippet from the page text instead.', {
      todo: 'Write a meta description of about 140–155 characters with the primary keyword and a reason to click.',
    });
  } else {
    const px = descriptionPixels(doc.description);
    if (px > DESC_MAX_PX) {
      desc.warn(`The meta description is too long (${px} pixels out of ${DESC_MAX_PX} max pixel length) and will be truncated.`, {
        todo: `Trim the meta description by roughly ${Math.ceil((px - DESC_MAX_PX) / 7)} characters.`,
      });
    } else if (px < DESC_MAX_PX * 0.4) {
      desc.warn(`The meta description is too short (${px} pixels out of ${DESC_MAX_PX} max pixel length).`, {
        todo: 'Extend the meta description toward 900–1000 pixels to use the full snippet.',
      });
    } else {
      desc.ok(`The length of the meta description is perfect. (${px} pixels out of ${DESC_MAX_PX} max pixel length)`);
    }

    desc.assert(
      doc.description.toLowerCase() !== doc.title.toLowerCase(),
      'The meta description is not a copy of the page title.',
      'The meta description duplicates the page title, wasting the snippet.',
      { todo: 'Rewrite the meta description so it adds information the title does not already give.' }
    );
  }

  // ---- Crawlability -------------------------------------------------------
  const crawl = audit.check('meta', 'Crawlability', 'critical', {
    help: 'If a page cannot be fetched or is told not to be indexed, nothing else on this report matters.',
  });

  crawl.assert(
    page.status >= 200 && page.status < 300,
    'There are no problems in accessing the page.',
    `The server answered with HTTP ${page.status} instead of 200.`,
    { severity: 'fail', todo: `Fix the HTTP ${page.status} response — search engines cannot index this URL as it stands.` }
  );

  crawl.assert(
    doc.index,
    'The page is allowed to be indexed.',
    `Indexing is blocked (${doc.robotsMeta ? `robots meta: ${doc.robotsMeta}` : `X-Robots-Tag: ${doc.xRobots}`}).`,
    { severity: 'fail', todo: 'Remove the noindex directive if this page is meant to appear in search results.' }
  );

  const blocked = robots.found ? robotsDisallows(robots.text, finalUrl.pathname + finalUrl.search) : false;
  crawl.assert(
    !blocked,
    'The URL is not blocked by robots.txt.',
    `robots.txt blocks this URL with "Disallow: ${blocked}".`,
    { severity: 'fail', todo: `Remove or narrow the "Disallow: ${blocked}" rule in robots.txt.` }
  );

  if (doc.refresh) {
    crawl.warn(`A meta refresh redirect is set ("${doc.refresh}"), which search engines treat as a weak redirect.`, {
      todo: 'Replace the meta refresh with a server-side 301 redirect.',
    });
  }

  // ---- Canonical ----------------------------------------------------------
  const canon = audit.check('meta', 'Canonical link', 'high', {
    value: doc.canonical,
    help: 'A canonical tag tells search engines which URL is the one true version of this page.',
  });

  if (!doc.canonical) {
    canon.warn('No canonical link is specified on this page.', {
      todo: 'Add a self-referencing canonical link so ranking signals are not split across URL variants.',
    });
  } else {
    canon.ok('There is a valid canonical link specified.');
    canon.assert(
      doc.canonicalAbsolute,
      'The canonical link uses an absolute URL.',
      'The canonical link is relative. Relative canonicals are error-prone and easy to misresolve.',
      { todo: 'Write the canonical link as a full absolute URL including the protocol and host.' }
    );
    canon.assert(
      doc.canonicalSelf,
      'The canonical link points to this page.',
      `The canonical points to a different URL (${doc.canonical}), so this URL will not be indexed on its own.`,
      { todo: 'Confirm the cross-canonical is intentional — otherwise point the canonical at this URL.' }
    );
  }

  // ---- Language -----------------------------------------------------------
  const lang = audit.check('meta', 'Language', 'low', {
    help: 'A declared language that contradicts the actual text can push the page into the wrong regional results.',
  });

  if (doc.language.code) lang.ok(`Language detected in text: ${doc.language.code}`);
  else lang.warn('The language of the page text could not be detected — there may be too little text.', { todo: 'Add more body copy so the page language is unambiguous.' });

  if (doc.htmlLang) {
    lang.ok(`The following language is defined in the HTML code: ${doc.htmlLang}`);
    const declared = doc.htmlLang.slice(0, 2).toLowerCase();
    if (doc.language.code) {
      lang.assert(
        declared === doc.language.code,
        'The declared language matches the language of the text.',
        `The HTML declares "${doc.htmlLang}" but the text reads as "${doc.language.code}".`,
        { todo: `Set the lang attribute to match the actual content language ("${doc.language.code}").` }
      );
    }
  } else {
    lang.warn('No language is declared in the HTML code.', { todo: 'Add a lang attribute to the <html> element, e.g. lang="en".' });
  }

  lang.info(`Server IP: ${host.ip || 'not resolved'}${transport.tlsVersion ? ` · TLS ${transport.tlsVersion}` : ''}`);

  // ---- Alternate / hreflang ----------------------------------------------
  const alt = audit.check('meta', 'Alternate/hreflang links', 'low', {
    help: 'hreflang is only needed when the same content exists in several languages or regions.',
  });
  if (!doc.hreflang.length) {
    alt.ok('There are no alternate links specified on this page.');
  } else {
    alt.ok(`${doc.hreflang.length} alternate ${plural(doc.hreflang.length, 'link')} specified: ${doc.hreflang.map((h) => h.lang).join(', ')}.`);
    alt.assert(
      doc.hreflang.some((h) => String(h.lang).toLowerCase() === 'x-default'),
      'An x-default alternate link is present.',
      'No x-default hreflang is specified for users outside the listed regions.',
      { todo: 'Add an x-default hreflang entry pointing at the fallback version of the page.' }
    );
    const selfRef = doc.hreflang.some((h) => {
      try { return new URL(h.href, finalUrl).href.replace(/\/$/, '') === finalUrl.href.replace(/\/$/, ''); } catch { return false; }
    });
    alt.assert(
      selfRef,
      'The hreflang set includes a self-reference.',
      'The hreflang set does not reference this page itself, so search engines may ignore the whole cluster.',
      { todo: 'Include a self-referencing hreflang entry in the set.' }
    );
  }

  // ---- Other meta tags ----------------------------------------------------
  const other = audit.check('meta', 'Other meta tags', 'low');
  other.assert(!doc.relNext, 'There is no rel=next meta tag on this page.', `A rel=next link points to ${doc.relNext}. Confirm the pagination sequence is still correct.`);
  other.assert(!doc.relPrev, 'There is no rel=prev meta tag on this page.', `A rel=prev link points to ${doc.relPrev}. Confirm the pagination sequence is still correct.`);
  const keywordsTag = doc.metaTags.find((m) => m.name.toLowerCase() === 'keywords');
  other.assert(
    !keywordsTag,
    'No obsolete meta keywords tag is used.',
    'The page still uses a meta keywords tag, which every major search engine ignores.',
    { todo: 'Delete the meta keywords tag — it does nothing and hands your keyword list to competitors.' }
  );

  // ---- Domain -------------------------------------------------------------
  const domain = audit.check('meta', 'Domain', 'low', { value: finalUrl.hostname });
  const labels = finalUrl.hostname.split('.');
  const isSubdomain = labels.length > 2 && labels[0] !== 'www';
  domain.assert(!isSubdomain, 'The domain is not a subdomain.', `The page is hosted on the subdomain "${labels[0]}", which accrues authority separately from the root domain.`);
  const sld = labels.length > 1 ? labels[labels.length - 2] : finalUrl.hostname;
  domain.assert(sld.length <= 20, 'The domain length works well.', `The domain name is long (${sld.length} characters), which hurts recall and typing accuracy.`);
  domain.assert(!/^xn--/i.test(finalUrl.hostname) && !/[^\x00-\x7F]/.test(finalUrl.hostname), 'The domain name does not contain any non-Latin characters.', 'The domain contains non-Latin characters, which some clients display as punycode.');

  // ---- Page URL -----------------------------------------------------------
  const urlCheck = audit.check('meta', 'Page URL', 'low', { value: finalUrl.pathname + finalUrl.search });
  const params = [...finalUrl.searchParams.keys()];
  const realParams = params.filter((p) => !TRACKING_PARAM.test(p));
  urlCheck.assert(realParams.length === 0, 'No parameters were found in the URL.', `The URL carries ${realParams.length} ${plural(realParams.length, 'parameter')} (${realParams.join(', ')}), which invites duplicate content.`, {
    todo: 'Serve this content on a clean, parameter-free URL and canonicalise the parameterised variants.',
  });
  urlCheck.assert(!params.some((p) => SESSION_PARAM.test(p)), 'No session ID was found in the URL.', 'The URL contains a session ID, which creates an unlimited number of duplicate URLs.', {
    severity: 'fail',
    todo: 'Move session handling into cookies and strip the session ID from URLs.',
  });
  const depth = finalUrl.pathname.split('/').filter(Boolean).length;
  urlCheck.assert(depth <= 4, 'The URL does not have too many subdirectories.', `The URL is ${depth} levels deep, which buries the page in the site hierarchy.`);
  urlCheck.assert(finalUrl.pathname.length <= 100, 'The URL length is fine.', `The URL path is ${finalUrl.pathname.length} characters long.`);
  urlCheck.assert(!/[A-Z_]/.test(finalUrl.pathname), 'The URL uses lowercase characters and hyphens.', 'The URL contains uppercase letters or underscores. Prefer lowercase words separated by hyphens.');

  // ---- Charset ------------------------------------------------------------
  const charset = audit.check('meta', 'Charset encoding', 'low');
  if (!doc.charset) {
    charset.warn('No character encoding is declared.', { todo: 'Add <meta charset="utf-8"> as the first element inside <head>.' });
  } else {
    charset.assert(/^UTF-?8$/i.test(doc.charset), `The charset encoding (${doc.charset}) is set correctly.`, `The page uses ${doc.charset} instead of UTF-8.`, {
      todo: 'Serve the page as UTF-8 to avoid mangled characters.',
    });
    charset.assert(Boolean(doc.charsetMeta), 'The charset is declared in the HTML.', 'The charset is only sent in the HTTP header, not declared in the HTML.', {
      todo: 'Declare <meta charset="utf-8"> in the document head as well as in the header.',
    });
  }

  // ---- Doctype ------------------------------------------------------------
  const dt = audit.check('meta', 'Doctype', 'nice', { value: doc.doctype.raw });
  dt.assert(doc.doctype.html5, 'The doctype HTML 5 is set correctly.', doc.doctype.present ? `A legacy doctype is used: ${doc.doctype.raw}` : 'No doctype is declared, so browsers fall back to quirks mode.', {
    todo: 'Declare <!DOCTYPE html> at the very top of the document.',
  });
  dt.assert(doc.doctype.first, 'The doctype is placed first in the HTML code.', 'Content appears before the doctype declaration.', {
    todo: 'Move the doctype declaration above all other markup.',
  });

  // ---- Favicon ------------------------------------------------------------
  const fav = audit.check('meta', 'Favicon', 'nice', { value: faviconCheck.url });
  fav.assert(faviconCheck.ok, 'The favicon is linked correctly.', faviconCheck.declared ? 'A favicon is declared but the file could not be loaded.' : 'No favicon was found for this page.', {
    todo: 'Add a favicon and link it from the head — it appears next to your result in Google and in browser tabs.',
  });
}

// ---------------------------------------------------------------------------
// Page quality
// ---------------------------------------------------------------------------

function runQualityChecks(audit, { doc, page, finalUrl, htmlBytes, transport }) {
  // ---- Content ------------------------------------------------------------
  const content = audit.check('quality', 'Content', 'critical', {
    help: 'Depth, structure and originality of the text on the page.',
  });

  if (doc.wordCount < 250) {
    content.fail(`There are only ${doc.wordCount} words on this page. Good pages should have about 800 words of useful content.`, {
      todo: `Expand the page from ${doc.wordCount} to at least 800 words of genuinely useful content.`,
    });
  } else if (doc.wordCount < 800) {
    content.warn(`There are only ${doc.wordCount} words on this page. Good pages should have about 800 words of useful content.`, {
      todo: `Add roughly ${800 - doc.wordCount} more words covering the subtopics a reader still has questions about.`,
    });
  } else {
    content.ok(`The page contains ${doc.wordCount} words of content. That is a good amount.`);
  }

  const stopPct = round1(doc.stopWordPct);
  if (doc.wordCount >= 50) {
    if (stopPct > 45) {
      content.warn(`${stopPct}% of the text are stop words, which is high — the copy says little per sentence.`, { todo: 'Tighten the prose so more of the text carries meaning.' });
    } else if (stopPct < 12) {
      content.warn(`Only ${stopPct}% of the text are stop words, which often signals keyword-stuffed or list-like copy.`, { todo: 'Rewrite the copy in natural sentences instead of keyword fragments.' });
    } else {
      content.ok(`${stopPct}% of the text are stop words.`);
    }
  }

  const titleTerms = tokenize(doc.title).filter((w) => !STOP_WORDS.has(w) && w.length > 2);
  if (titleTerms.length) {
    const bodyL = doc.bodyText.toLowerCase();
    const inBody = titleTerms.filter((t) => bodyL.includes(t));
    content.assert(
      inBody.length >= Math.ceil(titleTerms.length / 2),
      'Keywords used in the page title are also used in the page content. That\'s good!',
      `Most title keywords are missing from the body text (${inBody.length}/${titleTerms.length} found).`,
      { todo: 'Use the title\'s keywords naturally in the opening paragraphs and subheadings.' }
    );

    const h1L = doc.h1s.map((h) => h.text.toLowerCase()).join(' ');
    const missingInH1 = titleTerms.filter((t) => !h1L.includes(t));
    content.assert(
      missingInH1.length === 0,
      'All words from the page title are used in the H1 heading.',
      `Some words from the page title are not used within H1 headings (${missingInH1.slice(0, 6).join(', ')}).`,
      { todo: 'Align the H1 with the page title so both target the same query.' }
    );
  }

  const listCount = doc.lists.ul + doc.lists.ol + doc.lists.dl;
  content.assert(listCount > 0, 'The page contains a list, which indicates a good text structure.', 'No lists were found on the page.', {
    todo: 'Break dense passages into bulleted or numbered lists — they are also what AI answer engines quote.',
  });

  if (doc.paragraphs.length >= 5) {
    content.ok(`${doc.paragraphs.length} paragraphs (text blocks) were found on this page.`);
  } else {
    content.warn(`${qty(doc.paragraphs.length, 'paragraph')} (text ${plural(doc.paragraphs.length, 'block')}) ${doc.paragraphs.length === 1 ? 'was' : 'were'} found on this page.`, {
      todo: 'Split the copy into more, shorter paragraphs so it can be scanned.',
    });
  }

  const placeholders = doc.hasPlaceholderText || doc.placeholderImages > 0;
  content.assert(!placeholders, 'No placeholder texts or images were found.', doc.hasPlaceholderText ? 'Placeholder text (lorem ipsum or similar) is still on the page.' : `${doc.placeholderImages} placeholder ${plural(doc.placeholderImages, 'image')} ${doc.placeholderImages === 1 ? 'is' : 'are'} still on the page.`, {
    severity: 'fail',
    todo: 'Replace the remaining placeholder content with real copy and images.',
  });

  content.assert(doc.duplicateParagraphs === 0, 'There are no duplicate text blocks on the page.', `${doc.duplicateParagraphs} text ${plural(doc.duplicateParagraphs, 'block')} ${doc.duplicateParagraphs === 1 ? 'is' : 'are'} repeated on this page.`, {
    todo: 'Remove the repeated text blocks or make each one unique.',
  });

  const avg = doc.avgSentenceWords;
  if (!doc.sentences.length) {
    content.warn('No sentences could be identified in the page text.', { todo: 'Add real prose — the page currently reads as fragments.' });
  } else if (avg <= 25) {
    content.ok(`The average sentence length of ${round1(avg)} words is good.`);
  } else {
    content.warn(`The average sentence length of ${round1(avg)} words is too long.`, { todo: 'Break long sentences up — aim for an average under 20 words.' });
  }

  content.assert(
    doc.textIssues.length === 0,
    'No mechanical text errors were found.',
    `${doc.textIssues.length} possible text ${plural(doc.textIssues.length, 'error')} ${doc.textIssues.length === 1 ? 'was' : 'were'} found (repeated words, spacing or placeholder markers).`,
    { todo: 'Proofread the flagged passages listed under Elements → Text issues.' }
  );

  content.assert(
    doc.hasAuthorMarkup || doc.hasDateMarkup,
    `Trust signals are present (${[doc.hasAuthorMarkup && 'author markup', doc.hasDateMarkup && 'date markup'].filter(Boolean).join(' and ')}).`,
    'Neither author nor publication-date markup was found, weakening E-E-A-T signals.',
    { todo: 'Add visible authorship with credentials and a publish/updated date.' }
  );

  // ---- Frames -------------------------------------------------------------
  const frames = audit.check('quality', 'Frames', 'critical');
  frames.assert(doc.frames.frameset === 0, 'This page does not use a frameset.', 'This page uses a frameset, which search engines cannot index properly.', {
    severity: 'fail',
    todo: 'Replace the frameset with a normal HTML document structure.',
  });
  if (doc.frames.iframe > 3) {
    frames.warn(`${doc.frames.iframe} iframes are embedded. Content inside an iframe is not credited to this page.`, {
      todo: 'Reduce the number of iframes, or move important content into the page itself.',
    });
  } else {
    frames.ok(`${doc.frames.iframe === 0 ? 'No' : doc.frames.iframe} ${plural(doc.frames.iframe, 'iframe')} ${doc.frames.iframe === 1 ? 'is' : 'are'} used, which is unproblematic.`);
  }

  // ---- Mobile optimization ------------------------------------------------
  const mobile = audit.check('quality', 'Mobile optimization', 'low');
  const sizeKb = round1(htmlBytes / KB);
  if (sizeKb > 250) {
    mobile.warn(`The file size of the HTML document is very large (${sizeKb} kB).`, {
      todo: `Reduce the HTML payload from ${sizeKb} kB to under 150 kB — strip inlined data, unused markup and duplicated inline styles.`,
    });
  } else if (sizeKb > 150) {
    mobile.warn(`The file size of the HTML document is large (${sizeKb} kB).`, { todo: `Trim the HTML document below 150 kB (currently ${sizeKb} kB).` });
  } else {
    mobile.ok(`The file size of the HTML document is fine (${sizeKb} kB).`);
  }

  if (!doc.viewport) {
    mobile.fail('No viewport meta tag is provided, so mobile browsers render the desktop layout scaled down.', {
      todo: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
    });
  } else if (!/width\s*=\s*device-width/i.test(doc.viewport)) {
    mobile.warn(`The viewport (${doc.viewport}) does not set width=device-width.`, { todo: 'Set the viewport to width=device-width, initial-scale=1.' });
  } else if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/i.test(doc.viewport)) {
    mobile.warn(`The viewport blocks zooming (${doc.viewport}), which is an accessibility failure.`, { todo: 'Remove user-scalable=no / maximum-scale=1 from the viewport tag.' });
  } else {
    mobile.ok(`A viewport (${doc.viewport}) is provided.`);
  }

  mobile.assert(doc.appleTouchIcons.length > 0, 'One or more Apple Touch icons are specified.', 'No Apple Touch icon is specified for home-screen bookmarks.', {
    todo: 'Add an apple-touch-icon link (180×180 PNG).',
  });

  // ---- Strong / bold ------------------------------------------------------
  const bold = audit.check('quality', 'Strong and bold tags', 'low');
  const recommended = Math.max(6, Math.round(doc.wordCount / 100));
  if (doc.bold.length === 0) {
    bold.warn('No strong or bold tags are used on the page.', { todo: 'Emphasise the few phrases that carry the page\'s answer with <strong>.' });
  } else if (doc.bold.length > recommended) {
    bold.warn(`There are too many strong/bold tags (${doc.bold.length}). We recommend the use of up to ${recommended} tags for this page.`, {
      todo: `Reduce emphasis to about ${recommended} phrases — when everything is bold, nothing is.`,
    });
  } else {
    bold.ok(`The usage of strong and bold tags is perfect. We recommend the use of up to ${recommended} tags for this page.`);
  }

  // ---- Image SEO ----------------------------------------------------------
  const imgSeo = audit.check('quality', 'Image SEO', 'low');
  if (doc.images.length === 0) {
    imgSeo.info('No images were found on this page.');
  } else {
    const missing = doc.imagesMissingAlt.length;
    imgSeo.assert(
      missing === 0,
      'ALT text (alternative text) is correctly used on all found images.',
      `${missing} of ${doc.images.length} ${plural(doc.images.length, 'image')} ${missing === 1 ? 'has' : 'have'} no alt attribute at all.`,
      { todo: `Add descriptive alt text to the ${missing} ${plural(missing, 'image')} listed under Elements → Media files.` }
    );

    const generic = doc.images.filter((i) => i.src && GENERIC_IMAGE_NAME.test(i.src));
    imgSeo.assert(generic.length === 0, 'Image file names are descriptive.', `${generic.length} ${plural(generic.length, 'image')} ${generic.length === 1 ? 'uses' : 'use'} a generic file name such as IMG_1234.jpg.`, {
      todo: 'Rename images to describe their content, using hyphen-separated words.',
    });

    imgSeo.assert(
      doc.sizedImages.length === doc.images.length,
      'All images declare width and height, which protects Cumulative Layout Shift.',
      `${doc.images.length - doc.sizedImages.length} of ${doc.images.length} images do not declare width and height, which causes layout shift.`,
      { todo: 'Set explicit width and height (or aspect-ratio) on every image.' }
    );

    if (doc.images.length > 3) {
      imgSeo.assert(doc.lazyImages.length > 0, `${doc.lazyImages.length} of ${doc.images.length} images use loading="lazy".`, 'No image uses loading="lazy", so every image competes with the initial render.', {
        todo: 'Add loading="lazy" to below-the-fold images (never to the LCP image).',
      });
    }
  }

  // ---- Social media -------------------------------------------------------
  const social = audit.check('quality', 'Social media', 'nice');
  const shareSignals = doc.shareLinks.length + (doc.shareWidgets > 0 ? 1 : 0);
  social.assert(
    shareSignals > 0 || doc.socialProfiles.length >= 2,
    doc.shareLinks.length ? `${doc.shareLinks.length} sharing ${plural(doc.shareLinks.length, 'link')} and ${doc.socialProfiles.length} social ${plural(doc.socialProfiles.length, 'profile')} were found.` : `${doc.socialProfiles.length} social profile ${plural(doc.socialProfiles.length, 'link')} were found.`,
    'There are few social sharing options on the page. Sharing plugins can increase the page\'s reach on social media.',
    { todo: 'Add share buttons for the networks your audience actually uses.' }
  );

  const ogCount = ['title', 'description', 'image'].filter((k) => doc.openGraph[k]).length;
  social.assert(ogCount === 3, 'The core Open Graph tags (title, description, image) are set.', `${ogCount === 0 ? 'None' : `Only ${ogCount}`} of the 3 core Open Graph tags are set, so shared links will render a bare preview.`, {
    todo: 'Add og:title, og:description and og:image so shared links get a rich preview.',
  });
  social.assert(Boolean(doc.twitter.card), `A Twitter/X card is configured (${doc.twitter.card}).`, 'No twitter:card meta tag is set.', {
    todo: 'Add twitter:card="summary_large_image" plus twitter:title, description and image.',
  });

  // ---- Additional markup --------------------------------------------------
  const markup = audit.check('quality', 'Additional markup', 'nice');
  if (doc.jsonLd.length) {
    markup.ok(`Structured data was found: ${[...new Set(doc.jsonLd)].slice(0, 8).join(', ')}.`);
  } else if (doc.microdata || doc.rdfa) {
    markup.ok(`Page markup was found (${doc.microdata} microdata ${plural(doc.microdata, 'item')}, ${doc.rdfa} RDFa ${plural(doc.rdfa, 'attribute')}).`);
  } else {
    markup.warn('No additional page markup was found. Structured data helps search engines and AI systems understand the page.', {
      todo: 'Add JSON-LD schema.org markup for the page type (Organization, Article, Product, FAQ, …).',
    });
  }
  if (doc.jsonLdErrors.length) {
    markup.fail(`${doc.jsonLdErrors.length} JSON-LD ${plural(doc.jsonLdErrors.length, 'block')} could not be parsed and ${doc.jsonLdErrors.length === 1 ? 'is' : 'are'} ignored.`, {
      todo: 'Fix the invalid JSON-LD — malformed structured data is silently dropped.',
    });
  }

  // ---- HTTPS --------------------------------------------------------------
  const https = audit.check('quality', 'HTTPS', 'low');
  https.assert(finalUrl.protocol === 'https:', 'This page uses HTTPS to protect the privacy and integrity of information exchanged.', 'This page is served over unencrypted HTTP.', {
    severity: 'fail',
    todo: 'Install a TLS certificate and redirect all HTTP traffic to HTTPS.',
  });
  if (finalUrl.protocol === 'https:') {
    https.assert(doc.insecure.length === 0, 'All included files are also transferred via HTTPS.', `${doc.insecure.length} ${plural(doc.insecure.length, 'resource')} ${doc.insecure.length === 1 ? 'is' : 'are'} loaded over plain HTTP (${[...new Set(doc.insecure.map((i) => i.tag))].join(', ')}), which triggers mixed-content warnings.`, {
      todo: 'Load every script, style, image and iframe over HTTPS.',
    });
    if (transport.tlsVersion) {
      https.assert(/1\.[23]/.test(transport.tlsVersion), `A modern TLS version is used (${transport.tlsVersion}).`, `The server negotiated ${transport.tlsVersion}, which is deprecated.`, {
        todo: 'Disable TLS 1.0/1.1 and require TLS 1.2 or newer.',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Page structure
// ---------------------------------------------------------------------------

function runStructureChecks(audit, { doc }) {
  const h1 = audit.check('structure', 'H1 heading', 'critical', {
    value: doc.h1s.map((h) => h.text).filter(Boolean).join(' | ') || null,
    help: 'The H1 is the on-page headline: one per page, describing what the page answers.',
  });

  if (doc.h1s.length === 0) {
    h1.fail('There is no H1 heading specified.', { todo: 'Add exactly one H1 that states what the page is about.' });
  } else if (doc.h1s.length > 1) {
    h1.warn(`There are ${doc.h1s.length} H1 headings on this page. Best practice is exactly one.`, {
      todo: `Keep one H1 and demote the other ${doc.h1s.length - 1} to H2.`,
    });
  } else {
    h1.ok('The H1 heading is perfect.');
  }

  if (doc.h1s.length) {
    const text = doc.h1s[0].text;
    if (!text) {
      h1.fail('The H1 heading is empty.', { todo: 'Put descriptive text inside the H1 element.' });
    } else if (text.length < 15) {
      h1.warn(`The H1 heading is very short ("${text}").`, { todo: 'Expand the H1 into a descriptive phrase of about 20–70 characters.' });
    } else if (text.length > 110) {
      h1.warn(`The H1 heading is very long (${text.length} characters).`, { todo: 'Shorten the H1 to roughly 70 characters and move the detail into the body copy.' });
    } else {
      h1.ok(`The H1 heading has a good length (${text.length} characters).`);
    }
  }

  const headings = audit.check('structure', 'Headings', 'high', {
    help: 'Headings are the page outline — both readers and crawlers use them to navigate.',
  });

  const total = doc.headings.length;
  const h2 = doc.headings.filter((h) => h.level === 2).length;

  if (total === 0) {
    headings.fail('No headings were found on this page.', { todo: 'Structure the page with an H1 and descriptive H2/H3 subheadings.' });
  } else {
    headings.assert(h2 > 0, `The heading structure uses ${total} headings across ${new Set(doc.headings.map((h) => h.level)).size} levels.`, 'There are no H2 headings, so the page has no outline below the H1.', {
      todo: 'Add H2 subheadings for each distinct section of the page.',
    });
    headings.assert(
      doc.skippedHeadingLevels.length === 0,
      'The heading structure is perfect.',
      `${doc.skippedHeadingLevels.length} heading ${plural(doc.skippedHeadingLevels.length, 'level')} ${doc.skippedHeadingLevels.length === 1 ? 'is' : 'are'} skipped (e.g. H${doc.skippedHeadingLevels[0]?.from} followed by H${doc.skippedHeadingLevels[0]?.to}).`,
      { todo: 'Use heading levels in order without skipping — H2 before H3, and so on.' }
    );
    headings.assert(doc.emptyHeadings === 0, 'No empty headings were found.', `${doc.emptyHeadings} heading ${plural(doc.emptyHeadings, 'tag')} ${doc.emptyHeadings === 1 ? 'contains' : 'contain'} no text.`, {
      todo: 'Remove empty heading tags or give them real text — they are usually layout hacks.',
    });
    if (doc.wordCount > 300) {
      const per = Math.round(doc.wordCount / Math.max(1, total));
      headings.assert(per <= 200, `There is a heading roughly every ${per} words.`, `There is only one heading per ${per} words, so long passages have no signposting.`, {
        todo: 'Add subheadings so no block of text runs longer than about 200 words.',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Link structure
// ---------------------------------------------------------------------------

function runLinkChecks(audit, { doc }) {
  const internal = audit.check('links', 'Internal links', 'high', {
    help: 'Internal links tell search engines which of your pages matter and how they relate.',
  });

  const count = doc.internal.length;
  if (count === 0) {
    internal.fail('No internal links were found. The page is a dead end for crawlers.', { todo: 'Link from this page to the related pages on your site.' });
  } else if (count < 5) {
    internal.warn(`Only ${count} internal ${plural(count, 'link')} ${count === 1 ? 'was' : 'were'} found on this page.`, { todo: 'Add internal links to related pages so crawl paths and authority can flow.' });
  } else if (count > 300) {
    internal.warn(`There are very many internal links on this page (${count}), which dilutes the value each one passes.`, { todo: 'Reduce the number of internal links, especially repeated navigation blocks.' });
  } else {
    internal.ok('The number of internal links is ok.');
  }

  const anchorlessInternal = doc.internal.filter((l) => !l.hasAnchorText).length;
  internal.assert(
    anchorlessInternal === 0,
    'All internal links have anchor text.',
    `${anchorlessInternal} ${plural(anchorlessInternal, 'link')} ${anchorlessInternal === 1 ? "doesn't" : "don't"} have an anchor text.`,
    { todo: 'Give every link visible text, or an aria-label / image alt when the link is an icon.' }
  );

  internal.assert(
    doc.duplicateAnchors.length === 0,
    'Anchor texts are unique across internal links.',
    `Some anchor texts are used more than once for different targets (e.g. "${doc.duplicateAnchors[0]?.anchor}" → ${doc.duplicateAnchors[0]?.targets} URLs).`,
    { todo: 'Make anchor texts describe their specific destination instead of reusing the same words.' }
  );

  internal.assert(doc.longAnchors.length === 0, 'None of the link texts are too long.', `${doc.longAnchors.length} link ${plural(doc.longAnchors.length, 'text')} ${doc.longAnchors.length === 1 ? 'is' : 'are'} longer than 100 characters.`, {
    todo: 'Shorten overly long anchor texts to the few words that describe the target.',
  });

  internal.assert(doc.dynamicInternal.length === 0, 'There are no dynamic parameters used in internal links.', `${doc.dynamicInternal.length} internal ${plural(doc.dynamicInternal.length, 'link')} use dynamic parameters, which can create duplicate URLs.`, {
    todo: 'Link to clean URLs internally and keep parameters out of your own navigation.',
  });

  if (doc.fragments.length) {
    internal.info(`${doc.fragments.length} in-page anchor ${plural(doc.fragments.length, 'link')} (#…) ${doc.fragments.length === 1 ? 'was' : 'were'} ignored for this check.`);
  }

  const external = audit.check('links', 'External links', 'nice');
  external.ok(`There ${doc.external.length === 1 ? 'is' : 'are'} ${doc.external.length} external ${plural(doc.external.length, 'link')} on this page.`);
  external.assert(doc.unsafeTargets.length === 0, 'External links that open in a new tab are marked safely.', `${doc.unsafeTargets.length} external ${plural(doc.unsafeTargets.length, 'link')} open in a new tab without rel="noopener".`, {
    todo: 'Add rel="noopener noreferrer" to external links using target="_blank".',
  });
  const followed = doc.external.filter((l) => !l.nofollow).length;
  external.info(`${followed} of ${doc.external.length} external links pass link equity (the rest are nofollow).`);
}

// ---------------------------------------------------------------------------
// Server configuration
// ---------------------------------------------------------------------------

function runServerChecks(audit, { doc, page, finalUrl, htmlBytes, robots, sitemap, transport, hostVariant, httpsRedirect }) {
  // ---- Redirects ----------------------------------------------------------
  const redirects = audit.check('server', 'HTTP redirects', 'critical');
  const hops = page.redirectChain.length - 1;
  redirects.assert(hops === 0, 'The checked page does not redirect to another URL.', `The requested URL redirects ${hops} ${plural(hops, 'time')} before returning content (${page.redirectChain.map((r) => r.status).join(' → ')}).`, {
    todo: 'Link directly to the final URL so no redirect hop is needed.',
  });

  if (hostVariant.tested) {
    redirects.assert(
      hostVariant.canonicalized,
      'The redirect of URLs with www and non-www subdomain is configured correctly.',
      hostVariant.reachable
        ? `Both ${finalUrl.hostname} and ${hostVariant.host} serve content independently, which duplicates every page on the site.`
        : `The ${hostVariant.host} variant could not be reached (${hostVariant.error || `HTTP ${hostVariant.status}`}).`,
      { severity: hostVariant.reachable ? 'fail' : 'warn', todo: `301-redirect ${hostVariant.host} to ${finalUrl.hostname} so only one hostname is indexable.` }
    );
  }

  if (httpsRedirect.tested) {
    redirects.assert(httpsRedirect.upgrades, 'HTTP requests are redirected to HTTPS.', 'The HTTP version of this page does not redirect to HTTPS, leaving an unencrypted duplicate.', {
      todo: 'Add a site-wide 301 redirect from http:// to https://.',
    });
  }

  // ---- HTTP header --------------------------------------------------------
  const header = audit.check('server', 'HTTP header', 'high');
  const serverDate = page.headers.date ? Date.parse(page.headers.date) : null;
  if (serverDate) {
    const drift = Math.abs(Date.now() - serverDate);
    header.assert(drift < 90_000, `The clock on the server is set correctly (${Math.round(drift / 1000)} s from local time).`, `The clock on the server is set wrong (off by ${Math.round(drift / 1000)} seconds), which breaks caching and Last-Modified logic.`, {
      todo: 'Sync the server clock with NTP.',
    });
  } else {
    header.warn('The server sends no Date header, so caching freshness cannot be evaluated.', { todo: 'Configure the server to send a Date header.' });
  }

  const powered = page.headers['x-powered-by'];
  header.assert(!powered, 'No X-Powered HTTP header is sent.', `The server discloses its stack via X-Powered-By: ${powered}.`, {
    todo: 'Remove the X-Powered-By header — it only helps attackers fingerprint you.',
  });

  header.assert(Boolean(page.contentEncoding), `This page uses compression for data transfer (${page.contentEncoding}).`, 'This page is transferred without compression.', {
    todo: 'Enable gzip or Brotli compression for HTML, CSS and JavaScript.',
  });

  if (/\d+\.\d+/.test(String(page.headers.server || ''))) {
    header.warn(`The Server header exposes an exact version (${page.headers.server}).`, { todo: 'Configure the server to omit its version number from the Server header.' });
  }

  // ---- Security headers ---------------------------------------------------
  const security = audit.check('server', 'Security headers', 'low', {
    help: 'These headers do not rank the page, but they protect the trust signals that do.',
  });
  security.assert(Boolean(page.headers['strict-transport-security']), 'HSTS is enabled.', 'No Strict-Transport-Security header is sent.', {
    todo: 'Send Strict-Transport-Security with a max-age of at least six months.',
  });
  security.assert(page.headers['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options is set to nosniff.', 'No X-Content-Type-Options: nosniff header is sent.', {
    todo: 'Add X-Content-Type-Options: nosniff.',
  });
  security.assert(Boolean(page.headers['content-security-policy'] || page.headers['x-frame-options']), 'Framing protection is configured (CSP or X-Frame-Options).', 'Neither Content-Security-Policy nor X-Frame-Options is sent, so the page can be framed by anyone.', {
    todo: 'Add a Content-Security-Policy with frame-ancestors, or X-Frame-Options: SAMEORIGIN.',
  });
  security.assert(Boolean(page.headers['referrer-policy']), 'A Referrer-Policy is set.', 'No Referrer-Policy header is sent.', {
    todo: 'Add Referrer-Policy: strict-origin-when-cross-origin.',
  });

  // ---- Performance --------------------------------------------------------
  const perf = audit.check('server', 'Performance', 'low');
  const sizeKb = Math.round(htmlBytes / KB);
  perf.assert(sizeKb <= 250, `The file size of the HTML document is fine (${sizeKb} kB).`, `The file size of the HTML document is very large (${sizeKb} kB).`, {
    todo: `Reduce the HTML document from ${sizeKb} kB to under 150 kB.`,
  });

  const ttfb = Math.round(page.ttfbMs);
  if (ttfb <= 400) {
    perf.ok(`The HTML page response time of ${(ttfb / 1000).toFixed(2)} seconds is below the target of 0.40 seconds.`);
  } else if (ttfb <= 1000) {
    perf.warn(`The HTML page response time of ${(ttfb / 1000).toFixed(2)} seconds is above the target of 0.40 seconds.`, {
      todo: 'Reduce time to first byte with caching, a CDN, or faster server-side rendering.',
    });
  } else {
    perf.fail(`The HTML page response time of ${(ttfb / 1000).toFixed(2)} seconds is far above the target of 0.40 seconds.`, {
      todo: 'Investigate the slow server response — this directly damages Largest Contentful Paint.',
    });
  }

  perf.assert(page.transferBytes <= 200 * KB, `The transferred page weight is ${round1(page.transferBytes / KB)} kB over the wire.`, `The page transfers ${round1(page.transferBytes / KB)} kB of HTML, which is heavy for mobile connections.`, {
    todo: 'Reduce transferred HTML — compress, and move inline data out of the document.',
  });

  // ---- Protocol -----------------------------------------------------------
  const protocol = audit.check('server', 'Protocol & transport', 'low');
  if (transport.protocol) {
    protocol.assert(transport.protocol === 'HTTP/2', `The server supports ${transport.protocol}.`, `The server only offers ${transport.protocol}. HTTP/2 multiplexing would load the page faster.`, {
      todo: 'Enable HTTP/2 (or HTTP/3) on the server or CDN.',
    });
  }
  if (transport.certValidTo) {
    const daysLeft = Math.round((Date.parse(transport.certValidTo) - Date.now()) / 86_400_000);
    protocol.assert(daysLeft > 14, `The TLS certificate is valid for another ${daysLeft} days.`, daysLeft > 0 ? `The TLS certificate expires in ${daysLeft} days.` : 'The TLS certificate has expired.', {
      severity: daysLeft > 0 ? 'warn' : 'fail',
      todo: 'Renew the TLS certificate and verify auto-renewal is working.',
    });
  }

  // ---- robots.txt & sitemap ----------------------------------------------
  const crawlFiles = audit.check('server', 'robots.txt & sitemap', 'high');
  crawlFiles.assert(robots.found, 'A robots.txt file was found.', robots.htmlInstead ? 'The robots.txt URL returns an HTML page instead of a text file.' : `No robots.txt was found at ${finalUrl.origin}/robots.txt.`, {
    todo: 'Add a robots.txt at the site root, even if it only points to your sitemap.',
  });
  crawlFiles.assert(Boolean(robots.hasSitemap), `robots.txt references ${robots.sitemaps?.length || 0} ${plural(robots.sitemaps?.length || 0, 'sitemap')}.`, 'robots.txt does not reference an XML sitemap.', {
    todo: 'Add a "Sitemap:" line to robots.txt pointing at your XML sitemap.',
  });
  crawlFiles.assert(sitemap.found, `An XML sitemap is reachable and lists ${sitemap.urlCount} ${sitemap.isIndex ? 'child sitemaps' : 'URLs'}.`, 'No XML sitemap could be fetched.', {
    todo: 'Publish an XML sitemap and submit it in Google Search Console.',
  });
  if (robots.blocksAll) {
    crawlFiles.fail('robots.txt contains a site-wide "Disallow: /" for all user agents.', {
      todo: 'Remove the blanket Disallow rule — it is currently hiding the entire site.',
    });
  }
}

// ---------------------------------------------------------------------------
// Core Web Vitals (Chrome UX Report field data)
// ---------------------------------------------------------------------------

const VITALS_ADVICE = {
  lcp: 'Speed up the largest element: serve the hero image in a modern format at the right size, preload it, drop render-blocking CSS/JS, and cut server response time.',
  inp: 'Reduce main-thread work so the page answers input quickly: break up long tasks, defer third-party scripts, and shrink hydration work.',
  cls: 'Reserve space for anything that loads late: set width and height on images and embeds, and never insert banners above existing content.',
  fcp: 'Get the first paint out sooner: inline critical CSS, defer everything non-essential, and preconnect to required origins.',
  ttfb: 'Cut server response time with caching, a CDN, and less work per request.',
};

function runVitalsChecks(audit, { vitals }) {
  // Nothing here is inferable from the HTML — it is measured on real visitors'
  // devices. Without data the category is reported and excluded, never estimated.
  if (!vitals.available) {
    const summary = audit.check('vitals', 'Field data', 'critical', {
      help: 'Core Web Vitals come from real Chrome users, so they have to be fetched rather than inspected.',
    });
    summary.info(vitals.message || 'No Core Web Vitals field data is available.');
    if (vitals.reason === 'no-key') {
      summary.info('Set CRUX_API_KEY to score this category. The Chrome UX Report API is free; PageSpeed Insights is not a keyless alternative, since its anonymous quota is shared and routinely exhausted.');
    } else if (vitals.reason === 'no-data') {
      summary.info('CrUX only reports on addresses with enough real traffic. Lower-traffic pages have no field data at all — this says nothing about how fast the page is.');
    }
    audit.unmeasured('vitals', vitals.message || 'Core Web Vitals field data is unavailable, so this category is reported but excluded from the score.');
    return;
  }

  const scopeNote = vitals.scope === 'origin'
    ? `Measured across the whole origin${vitals.fellBackFromUrl ? ' — this URL alone has too little traffic for its own record' : ''}.`
    : 'Measured for this exact URL.';

  for (const key of ['lcp', 'inp', 'cls', 'fcp', 'ttfb']) {
    const metric = vitals.metrics[key];
    if (!metric) continue;

    const t = THRESHOLDS[key];
    const check = audit.check('vitals', metric.label, t.core ? 'critical' : 'low', {
      value: `${metric.display} at the 75th percentile`,
      help: key === 'lcp' ? scopeNote : null,
    });

    const goodText = t.unit === 'ms' ? `${t.good} ms` : t.good;
    const poorText = t.unit === 'ms' ? `${t.poor} ms` : t.poor;

    if (metric.rating === 'good') {
      check.ok(`${metric.display} is within the "good" threshold of ${goodText}.`);
    } else if (metric.rating === 'needs-improvement') {
      check.warn(`${metric.display} needs improvement — "good" is ${goodText} or less.`, { todo: VITALS_ADVICE[key] });
    } else {
      check.fail(`${metric.display} is poor — above the ${poorText} failure threshold.`, { todo: VITALS_ADVICE[key] });
    }

    // Informational, not scored: a p75 inside the threshold already implies at
    // least 75% good visits, so scoring the split would penalise the same fault
    // twice and repeat the same fix in the to-do list. It is still worth showing —
    // the p75 hides how bad the slow tail is for real people.
    check.info(`${metric.good}% of visits good · ${metric.needsImprovement}% need improvement · ${metric.poor}% poor.`);
  }

  const overall = audit.check('vitals', 'Core Web Vitals assessment', 'high', {
    help: 'Google treats the assessment as passed only when LCP, INP and CLS are all good.',
  });
  overall.assert(
    vitals.passes,
    'This page passes the Core Web Vitals assessment.',
    'This page does not pass the Core Web Vitals assessment — all three of LCP, INP and CLS must be good.',
    { todo: 'Bring every failing Core Web Vital into the good range; a single failing metric fails the whole assessment.' }
  );
  overall.info(`${scopeNote}${vitals.collectionPeriod ? ` Collection period ${vitals.collectionPeriod.from} to ${vitals.collectionPeriod.to}.` : ''} Form factor: ${vitals.formFactor}.`);
}

// ---------------------------------------------------------------------------
// External factors
// ---------------------------------------------------------------------------

function runExternalChecks(audit, { doc }) {
  const backlinks = audit.check('external', 'Backlinks', 'critical', {
    help: 'Off-page authority cannot be measured from the page source — it needs a backlink index.',
  });
  backlinks.info('Backlink volume, referring domains and referring IPs are not measured by this tool. They require a third-party link index (Ahrefs, Majestic, Semrush) or Google Search Console.');
  backlinks.info('Connect a backlink data source to score this category. Until then it is excluded from the on-page score rather than guessed at.');

  const entity = audit.check('external', 'Entity signals', 'low', {
    help: 'What the page itself asserts about the organisation behind it — the part of off-page trust you control.',
  });
  const orgSchema = doc.jsonLd.some((t) => /Organization|LocalBusiness|Person|WebSite/i.test(t));
  entity.assert(orgSchema, 'The page declares an Organization, Person or WebSite entity in structured data.', 'No Organization/Person entity is declared in structured data, so search engines must infer who publishes this page.', {
    todo: 'Add Organization (or Person) JSON-LD with name, logo, url and sameAs profile links.',
  });
  entity.assert(doc.socialProfiles.length >= 2, `${doc.socialProfiles.length} social profile links corroborate the publisher's identity.`, `${qty(doc.socialProfiles.length, 'social profile link')} ${doc.socialProfiles.length === 1 ? 'was' : 'were'} found on the page.`, {
    todo: 'Link your official social profiles from the page and mirror them in schema.org sameAs.',
  });

  audit.unmeasured('external', 'Backlink metrics need an external link index, so this category is reported but excluded from the score.');
}

// ---------------------------------------------------------------------------
// Elements inventory
// ---------------------------------------------------------------------------

function buildElements({ doc, page, transport, keywords, keywordScope }) {
  const headers = [];
  for (let i = 0; i < page.rawHeaders.length; i += 2) {
    headers.push({ name: page.rawHeaders[i], value: page.rawHeaders[i + 1] });
  }

  return {
    headings: {
      count: doc.headings.length,
      byLevel: [1, 2, 3, 4, 5, 6].map((level) => ({ level, count: doc.headings.filter((h) => h.level === level).length })),
      list: doc.headings,
    },
    paragraphs: { count: doc.paragraphs.length, list: doc.paragraphs },
    textIssues: { count: doc.textIssues.length, list: doc.textIssues },
    bold: { count: doc.bold.length, list: doc.bold },
    media: {
      count: doc.media.length,
      images: doc.images.length,
      withAlt: doc.imagesWithAlt.length,
      missingAlt: doc.imagesMissingAlt.length,
      lazy: doc.lazyImages.length,
      inlineSvg: doc.inlineSvg,
      list: doc.media,
    },
    metaTags: { count: doc.metaTags.length, list: doc.metaTags },
    internalLinks: { count: doc.internal.length, list: doc.internal },
    externalLinks: { count: doc.external.length, list: doc.external },
    httpHeaders: {
      protocol: transport.protocol || `HTTP/${page.httpVersion}`,
      count: headers.length,
      list: headers,
      redirectChain: page.redirectChain,
    },
    keywords: { count: keywords.list.length, basisWords: keywords.tokenCount, basisScope: keywordScope, list: keywords.list },
    summary: {
      lists: doc.lists.ul + doc.lists.ol + doc.lists.dl,
      tables: doc.tables,
      structuredData: [...new Set(doc.jsonLd)],
      openGraph: doc.openGraph,
      twitter: doc.twitter,
      fragments: doc.fragments.length,
      mailtoTel: doc.mailtoTel.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Supporting probes & utilities
// ---------------------------------------------------------------------------

async function checkFavicon(doc, finalUrl, cache) {
  const declared = doc.favicons.find((f) => f.href);
  const target = declared ? new URL(declared.href, finalUrl).href : `${finalUrl.origin}/favicon.ico`;

  // Across a crawl every page usually declares the same icon — probe it once.
  if (cache?.has(target)) return { ...cache.get(target), declared: Boolean(declared) };

  const res = await probe(target);
  const type = String(res.headers?.['content-type'] || '');
  const result = {
    declared: Boolean(declared),
    url: target,
    ok: res.ok && !/text\/html/i.test(type),
    status: res.status,
  };
  cache?.set(target, result);
  return result;
}

// Do www and non-www resolve to the same canonical hostname?
async function checkHostVariant(finalUrl) {
  const host = finalUrl.hostname.startsWith('www.')
    ? finalUrl.hostname.slice(4)
    : `www.${finalUrl.hostname}`;
  // A multi-label host without www (e.g. blog.example.com) has no meaningful variant.
  if (!finalUrl.hostname.startsWith('www.') && finalUrl.hostname.split('.').length > 2) {
    return { tested: false };
  }

  try {
    const res = await fetchPage(`${finalUrl.protocol}//${host}/`, { maxRedirects: 4, timeout: 10000, maxBytes: 8 * 1024 });
    const landed = new URL(res.redirectChain[res.redirectChain.length - 1].url);
    return {
      tested: true,
      host,
      reachable: res.status >= 200 && res.status < 300,
      status: res.status,
      canonicalized: landed.hostname === finalUrl.hostname,
      landedOn: landed.href,
    };
  } catch (err) {
    return { tested: true, host, reachable: false, canonicalized: false, error: err.message };
  }
}

async function checkHttpUpgrade(finalUrl) {
  try {
    const res = await fetchPage(`http://${finalUrl.host}${finalUrl.pathname}`, { maxRedirects: 4, timeout: 10000, maxBytes: 8 * 1024 });
    const landed = new URL(res.redirectChain[res.redirectChain.length - 1].url);
    return { tested: true, upgrades: landed.protocol === 'https:', landedOn: landed.href };
  } catch {
    // An unreachable HTTP port is effectively HTTPS-only, which is the desired state.
    return { tested: true, upgrades: true, note: 'HTTP port not reachable' };
  }
}

export function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Please provide a URL to analyze.');
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`);
  }
  if (!url.hostname.includes('.')) throw new Error(`"${raw}" is not a valid public hostname.`);
  return url;
}

function decodeBody(buffer, headers) {
  const headerCharset = (String(headers['content-type'] || '').match(/charset=["']?([\w-]+)/i) || [])[1];
  const sniff = buffer.subarray(0, 4096).toString('latin1');
  const metaCharset = (sniff.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  const charset = (headerCharset || metaCharset || 'utf-8').toLowerCase();

  if (/^(utf-?8|us-ascii)$/.test(charset)) return buffer.toString('utf8');
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

function duplicates(list) {
  const seen = new Set();
  const dupes = new Set();
  for (const item of list) {
    if (seen.has(item)) dupes.add(item);
    seen.add(item);
  }
  return [...dupes];
}

function plural(n, word) {
  if (n === 1) return word;
  if (/y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|sh|ch|x)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

// "No paragraphs" / "1 paragraph" / "6 paragraphs" — reads correctly at zero.
function qty(n, word) {
  return `${n === 0 ? 'No' : n} ${plural(n, word)}`;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function gradeFor(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}
