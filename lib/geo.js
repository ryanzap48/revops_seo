// lib/geo.js
// Generative Engine Optimization: whether an AI answer engine can fetch this
// page, extract a passage from it, and have reason to cite it.
//
// The weighting follows the evidence rather than folklore. The KDD 2024 paper
// "GEO: Generative Engine Optimization" (Aggarwal et al., arxiv.org/abs/2311.09735)
// tested nine content strategies over 10,000 queries and found that adding
// statistics, citations and quotations raised citation rates by up to 40%, while
// keyword density — the classic SEO lever — barely moved them. So evidence
// signals are weighted heavily here and keyword density is not scored at all.
//
// Retrieval crawlers are separated from training crawlers throughout. Blocking
// GPTBot or ClaudeBot is a defensible licensing decision that costs nothing in
// citations; blocking OAI-SearchBot or PerplexityBot removes the page from the
// answers themselves. Conflating the two produces bad advice.

import { parseRobots, isAllowed } from './robots.js';
import { tokenize, STOP_WORDS } from './text.js';

// ---- The AI crawler landscape ---------------------------------------------

export const AI_CRAWLERS = [
  // Retrieval: these decide whether you can appear in a generated answer.
  { ua: 'OAI-SearchBot',   vendor: 'OpenAI',     surface: 'ChatGPT Search',       role: 'retrieval' },
  { ua: 'PerplexityBot',   vendor: 'Perplexity', surface: 'Perplexity answers',   role: 'retrieval' },
  { ua: 'Claude-SearchBot',vendor: 'Anthropic',  surface: 'Claude web search',    role: 'retrieval' },
  { ua: 'DuckAssistBot',   vendor: 'DuckDuckGo', surface: 'DuckAssist',           role: 'retrieval' },
  { ua: 'Amazonbot',       vendor: 'Amazon',     surface: 'Alexa answers',        role: 'retrieval' },

  // User-triggered: fetched live when someone follows or expands a citation.
  { ua: 'ChatGPT-User',    vendor: 'OpenAI',     surface: 'ChatGPT live fetch',   role: 'user-triggered' },
  { ua: 'Perplexity-User', vendor: 'Perplexity', surface: 'Perplexity live fetch',role: 'user-triggered' },
  { ua: 'Claude-User',     vendor: 'Anthropic',  surface: 'Claude live fetch',    role: 'user-triggered' },
  { ua: 'MistralAI-User',  vendor: 'Mistral',    surface: 'Le Chat live fetch',   role: 'user-triggered' },

  // Training: blocking these is a licensing choice, not a visibility problem.
  { ua: 'GPTBot',          vendor: 'OpenAI',     surface: 'model training',       role: 'training' },
  { ua: 'ClaudeBot',       vendor: 'Anthropic',  surface: 'model training',       role: 'training' },
  { ua: 'Google-Extended', vendor: 'Google',     surface: 'Gemini training',      role: 'training' },
  { ua: 'Meta-ExternalAgent', vendor: 'Meta',    surface: 'Meta AI training',     role: 'training' },
  { ua: 'CCBot',           vendor: 'Common Crawl', surface: 'open crawl corpus',  role: 'training' },
  { ua: 'AI2Bot',          vendor: 'Allen AI',   surface: 'open research corpus', role: 'training' },
  { ua: 'cohere-ai',       vendor: 'Cohere',     surface: 'model training',       role: 'training' },
];

export const ROLE_LABEL = {
  retrieval: 'Retrieval — decides citation eligibility',
  'user-triggered': 'User-triggered — fetches a page when someone follows a citation',
  training: 'Training — model training corpora',
};

/** Evaluate robots.txt against every AI crawler for a given path. */
export function evaluateCrawlerAccess(robotsText, pathWithQuery) {
  const parsed = parseRobots(String(robotsText || ''));
  const bots = AI_CRAWLERS.map((bot) => {
    const verdict = isAllowed(parsed, pathWithQuery, bot.ua);
    return {
      ...bot,
      allowed: verdict.allowed,
      rule: verdict.rule,
      viaSpecificRule: verdict.specific,
      crawlDelay: verdict.crawlDelay,
    };
  });

  const by = (role) => bots.filter((b) => b.role === role);
  return {
    bots,
    retrieval: by('retrieval'),
    userTriggered: by('user-triggered'),
    training: by('training'),
    blockedRetrieval: by('retrieval').filter((b) => !b.allowed),
    blockedUserTriggered: by('user-triggered').filter((b) => !b.allowed),
    blockedTraining: by('training').filter((b) => !b.allowed),
  };
}

// ---- Content signals -------------------------------------------------------

const QUESTION_START = /^(what|why|how|when|where|who|whom|whose|which|can|could|do|does|did|is|are|was|were|should|will|would|has|have|may|might)\b/i;

// Numbers that carry evidential weight: percentages, money, multiples, scaled
// counts, and explicit units. A bare "3" in a sentence is not a statistic.
const STAT_PATTERNS = [
  /\b\d{1,3}(?:\.\d+)?\s?%/,
  /\b\d+(?:\.\d+)?\s?(?:percent|percentage points?|pp)\b/i,
  /[$£€¥]\s?\d[\d,.]*\s?(?:k|m|bn|b|billion|million|trillion)?\b/i,
  /\b\d[\d,]*\s?(?:million|billion|trillion|thousand)\b/i,
  /\b\d{1,3}(?:,\d{3})+\b/,
  /\b\d+(?:\.\d+)?\s?(?:x|×)\b/i,
  /\b\d+(?:\.\d+)?\s?(?:hours?|days?|weeks?|months?|years?|minutes?|seconds?|ms)\b/i,
  /\b(?:\d+(?:\.\d+)?)\s?(?:out of|of)\s?\d+\b/i,
];

const AUTHORITATIVE_HOSTS = [
  'nih.gov', 'cdc.gov', 'cms.gov', 'hhs.gov', 'fda.gov', 'who.int', 'europa.eu',
  'doi.org', 'arxiv.org', 'pubmed.ncbi.nlm.nih.gov', 'nejm.org', 'jamanetwork.com',
  'thelancet.com', 'nature.com', 'science.org', 'sciencedirect.com', 'ieee.org',
  'acm.org', 'w3.org', 'ietf.org', 'iso.org', 'nist.gov', 'census.gov', 'bls.gov',
  'oecd.org', 'worldbank.org', 'imf.org', 'wikipedia.org', 'wikidata.org',
  'gartner.com', 'forrester.com', 'mckinsey.com', 'statista.com', 'pewresearch.org',
  'hl7.org', 'himss.org', 'ahima.org', 'aha.org', 'mgma.com',
];

const isAuthoritativeHost = (host) => {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (/\.(gov|edu|mil|int)$/.test(h)) return true;
  return AUTHORITATIVE_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
};

/**
 * Derive the GEO-relevant view of a page from the shared document model.
 * Operates on the already-parsed DOM, so nothing is re-parsed.
 */
export function analyzeGeoSignals(doc, pageUrl) {
  const $ = doc.$;

  // --- Passage structure: what a retrieval system would chunk on ------------
  const sections = [];
  $('h2').each((_, el) => {
    const heading = $(el).text().replace(/\s+/g, ' ').trim();
    let words = 0;
    let node = $(el).next();
    while (node.length && !/^h[12]$/i.test(node.get(0)?.tagName || '')) {
      words += tokenize(node.text()).length;
      node = node.next();
    }
    sections.push({ heading, words });
  });

  const questionHeadings = doc.headings.filter((h) => h.level >= 2 && (h.text.trim().endsWith('?') || QUESTION_START.test(h.text.trim())));

  // --- Opening answer: what gets read first --------------------------------
  const opening = doc.paragraphs.slice(0, 3).join(' ');
  const openingWords = tokenize(opening).length;
  const firstParagraphWords = doc.paragraphs.length ? tokenize(doc.paragraphs[0]).length : 0;

  // Does the opening actually address the page's own topic?
  const titleTerms = tokenize(doc.title).filter((w) => !STOP_WORDS.has(w) && w.length > 3);
  const openingLower = opening.toLowerCase();
  const titleTermsInOpening = titleTerms.filter((t) => openingLower.includes(t)).length;

  // --- Evidence -------------------------------------------------------------
  // Figures live in stat blocks, list items and table cells at least as often as
  // in prose, so scanning paragraphs alone misses most of them.
  const textBlocks = [...doc.paragraphs, ...doc.headings.filter((h) => h.level >= 2).map((h) => h.text)];
  $('li, td, th, dd, figcaption').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text && text.length <= 400) textBlocks.push(text);
  });

  const statBlocks = textBlocks.filter((t) => STAT_PATTERNS.some((re) => re.test(t)));
  const statMatches = [];
  for (const block of statBlocks) {
    for (const re of STAT_PATTERNS) {
      const m = block.match(re);
      if (m) { statMatches.push(m[0].trim()); break; }
    }
  }

  // These three detectors overlap: a <blockquote> whose text also carries curly
  // quotes would otherwise be counted twice and inflate the total. Each passage
  // is attributed to exactly one detector, strongest markup first.
  const blockquotes = $('blockquote').length;
  const blockquoteText = $('blockquote').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();

  const inlineQuotes = $('q').filter((_, el) => $(el).closest('blockquote').length === 0).length;

  // Quotation marks only count where no element already marks the passage up.
  let outsideMarkup = doc.bodyText;
  for (const quoted of blockquoteText) {
    if (quoted) outsideMarkup = outsideMarkup.split(quoted).join(' ');
  }
  const quotedPassages = (outsideMarkup.match(/[“"][^”"]{40,400}[”"]/g) || []).length;

  const markedQuotations = blockquotes + inlineQuotes + quotedPassages;

  const citations = doc.external.map((l) => {
    let host = '';
    try { host = new URL(l.href).hostname; } catch { /* ignore */ }
    return { href: l.href, host, anchor: l.anchor, authoritative: isAuthoritativeHost(host) };
  });
  const authoritativeCitations = citations.filter((c) => c.authoritative);

  // --- Rendering: can a non-JS fetch see the content? ----------------------
  const scriptCount = $('script').length;
  const spaRoot = $('#root, #app, #__next, [data-reactroot], [ng-app], [data-server-rendered]').length > 0;
  const clientRendered = doc.wordCount < 200 && scriptCount >= 5;

  // --- Freshness ------------------------------------------------------------
  const dateModified = $('meta[property="article:modified_time"]').attr('content')
    || $('[itemprop="dateModified"]').attr('content')
    || $('time[datetime]').first().attr('datetime')
    || null;
  const jsonLdDates = extractJsonLdDates($);
  const freshest = [dateModified, jsonLdDates.modified, jsonLdDates.published].filter(Boolean).sort().pop() || null;
  const ageDays = freshest ? Math.round((Date.now() - Date.parse(freshest)) / 86_400_000) : null;

  // --- Entity ---------------------------------------------------------------
  const jsonLdNodes = collectJsonLd($);
  const orgNode = jsonLdNodes.find((n) => /Organization|LocalBusiness|Corporation|MedicalOrganization/i.test(typeString(n['@type'])));
  const personNode = jsonLdNodes.find((n) => /^Person$/i.test(typeString(n['@type'])));
  const entityNode = orgNode || personNode || null;
  const sameAs = entityNode?.sameAs ? [].concat(entityNode.sameAs) : [];

  const schemaTypes = [...new Set(jsonLdNodes.map((n) => typeString(n['@type'])).filter(Boolean))];
  const hasAnswerSchema = schemaTypes.some((t) => /FAQPage|QAPage|HowTo|Question/i.test(t));
  const hasArticleSchema = schemaTypes.some((t) => /Article|BlogPosting|NewsArticle|Report/i.test(t));

  return {
    sections,
    thinSections: sections.filter((s) => s.words > 0 && s.words < 40),
    longSections: sections.filter((s) => s.words > 350),
    emptySections: sections.filter((s) => s.words === 0),
    questionHeadings,
    questionHeadingRatio: doc.headings.filter((h) => h.level >= 2).length
      ? questionHeadings.length / doc.headings.filter((h) => h.level >= 2).length
      : 0,

    opening,
    openingWords,
    firstParagraphWords,
    titleTermsInOpening,
    titleTermCount: titleTerms.length,

    statistics: { count: statBlocks.length, samples: [...new Set(statMatches)].slice(0, 12) },
    quotations: { blockquotes, inlineQuotes, quotedPassages, marked: markedQuotations, total: markedQuotations },
    citations,
    authoritativeCitations,

    lists: doc.lists.ul + doc.lists.ol + doc.lists.dl,
    tables: doc.tables,

    clientRendered,
    scriptCount,
    spaRoot,

    freshness: { date: freshest, ageDays },
    entity: {
      node: entityNode ? { type: typeString(entityNode['@type']), name: entityNode.name || null } : null,
      sameAs,
      hasAuthor: doc.hasAuthorMarkup,
    },
    schemaTypes,
    hasAnswerSchema,
    hasArticleSchema,
    pageUrl,
  };
}

// ---- Checks ----------------------------------------------------------------

export function runGeoChecks(audit, { doc, geo, access, llms, page, finalUrl }) {
  crawlerAccessChecks(audit, { access, llms, doc, geo, page });
  answerReadinessChecks(audit, { doc, geo });
  evidenceChecks(audit, { geo });
  authorityChecks(audit, { doc, geo, finalUrl });
  machineReadableChecks(audit, { doc, geo });
}

function crawlerAccessChecks(audit, { access, llms, doc, geo, page }) {
  const retrieval = audit.check('access', 'Retrieval crawler access', 'critical', {
    help: 'These crawlers decide whether the page can be quoted in an AI answer at all. Everything else in this report is moot if they are blocked.',
  });

  if (!access.available) {
    retrieval.info('No robots.txt was found, so no crawler is blocked by it. That is the permissive default.');
    retrieval.ok('No robots.txt rule blocks any AI retrieval crawler.');
  } else if (access.blockedRetrieval.length === 0) {
    retrieval.ok(`All ${access.retrieval.length} AI retrieval crawlers are allowed to fetch this URL.`);
  } else {
    retrieval.fail(
      `${access.blockedRetrieval.length} of ${access.retrieval.length} retrieval crawlers are blocked: ${access.blockedRetrieval.map((b) => `${b.ua} (${b.surface})`).join(', ')}.`,
      { todo: `Allow ${access.blockedRetrieval.map((b) => b.ua).join(', ')} in robots.txt — while blocked, this page cannot be cited in those answer engines.` }
    );
  }

  if (access.blockedUserTriggered.length === 0) {
    retrieval.ok('User-triggered fetchers can load the page when someone follows a citation.');
  } else {
    retrieval.warn(
      `${access.blockedUserTriggered.map((b) => b.ua).join(', ')} ${access.blockedUserTriggered.length === 1 ? 'is' : 'are'} blocked, so the page cannot be opened when a reader follows a citation to it.`,
      { todo: `Allow ${access.blockedUserTriggered.map((b) => b.ua).join(', ')} — these fetch on a user's behalf, not for training.` }
    );
  }

  // Blocking training crawlers is a legitimate choice, so it is reported without
  // being penalised. Saying otherwise would push publishers into licensing
  // decisions this tool has no business making for them.
  if (access.blockedTraining.length) {
    retrieval.info(`Training crawlers blocked: ${access.blockedTraining.map((b) => b.ua).join(', ')}. This does not affect citation eligibility — it only opts out of model training.`);
  } else {
    retrieval.info('No training crawlers are blocked. Blocking them is a licensing choice and would not reduce citation eligibility.');
  }

  const indexable = audit.check('access', 'Page availability', 'critical');
  indexable.assert(
    page.status >= 200 && page.status < 300,
    'The page returns a successful response.',
    `The page returns HTTP ${page.status}, so no engine can read it.`,
    { severity: 'fail', todo: `Fix the HTTP ${page.status} response.` }
  );
  indexable.assert(
    doc.index,
    'The page is not marked noindex.',
    'The page is marked noindex. AI search surfaces generally respect it, so the page is excluded from answers.',
    { severity: 'fail', todo: 'Remove the noindex directive if this page should appear in AI answers.' }
  );

  const rendering = audit.check('access', 'Server-rendered content', 'critical', {
    help: 'Most AI crawlers do not execute JavaScript. Whatever is not in the HTML response does not exist to them.',
  });
  rendering.assert(
    !geo.clientRendered,
    `${doc.wordCount} words are present in the raw HTML, without needing JavaScript.`,
    `Only ${doc.wordCount} words are in the raw HTML across ${geo.scriptCount} scripts — the content appears to be rendered client-side, so AI crawlers will see an empty page.`,
    { severity: 'fail', todo: 'Server-render or pre-render the main content so it is present in the HTML response.' }
  );

  const llmsCheck = audit.check('access', 'llms.txt', 'nice', {
    help: 'A proposed convention for pointing LLMs at your key content. Worth having, but hold expectations: adoption is around 9% of top sites and no measured citation lift has been demonstrated.',
  });
  llmsCheck.assert(
    llms.found,
    `An llms.txt file is published (${llms.bytes} bytes).`,
    'No llms.txt file is published.',
    { todo: 'Optionally publish /llms.txt linking to your most important pages. Treat it as cheap insurance, not a ranking lever.' }
  );
}

function answerReadinessChecks(audit, { doc, geo }) {
  const opening = audit.check('answers', 'Opening answer', 'critical', {
    value: doc.paragraphs[0] ? doc.paragraphs[0].slice(0, 220) : null,
    help: 'Retrieval systems weigh the opening of a page heavily. The first passage should answer the question the page exists to answer.',
  });

  if (!doc.paragraphs.length) {
    opening.fail('The page has no paragraph text to answer with.', { todo: 'Open the page with a direct, self-contained answer of one or two sentences.' });
  } else {
    opening.assert(
      geo.firstParagraphWords >= 15,
      `The opening paragraph is ${geo.firstParagraphWords} words — long enough to state an answer.`,
      `The opening paragraph is only ${geo.firstParagraphWords} words, too short to answer anything.`,
      { todo: 'Lead with a direct answer of roughly 40–80 words before any preamble.' }
    );
    opening.assert(
      geo.firstParagraphWords <= 120,
      'The opening paragraph is concise enough to be quoted whole.',
      `The opening paragraph runs ${geo.firstParagraphWords} words, too long to lift as a quotable answer.`,
      { todo: 'Tighten the opening to a quotable 40–80 word answer and move the detail below it.' }
    );
    opening.assert(
      geo.titleTermCount === 0 || geo.titleTermsInOpening > 0,
      'The opening text covers the subject named in the title.',
      'The opening text does not mention the subject from the page title, so a retrieval system may not connect the two.',
      { todo: 'Name the page\'s subject explicitly in the first sentence rather than alluding to it.' }
    );
  }

  const chunks = audit.check('answers', 'Passage structure', 'critical', {
    help: 'AI systems retrieve passages, not pages. Each section should stand alone as an answer to one question.',
  });

  const h2Count = doc.headings.filter((h) => h.level === 2).length;
  chunks.assert(
    h2Count >= 2,
    `${h2Count} H2 sections give the page a retrievable structure.`,
    h2Count === 0 ? 'The page has no H2 sections, so it is one undifferentiated block to a retrieval system.' : 'The page has only one H2 section, so there is little for a retrieval system to choose between.',
    { todo: 'Break the page into H2 sections, each answering one specific question.' }
  );
  chunks.assert(
    geo.thinSections.length === 0,
    'No section is too thin to stand on its own.',
    `${geo.thinSections.length} ${geo.thinSections.length === 1 ? 'section is' : 'sections are'} under 40 words (${geo.thinSections.slice(0, 3).map((s) => `"${s.heading}"`).join(', ')}), too thin to be retrieved as an answer.`,
    { todo: 'Give every section enough self-contained substance to answer its heading, or merge it into a neighbour.' }
  );
  chunks.assert(
    geo.longSections.length === 0,
    'No section is so long that its answer gets diluted.',
    `${geo.longSections.length} ${geo.longSections.length === 1 ? 'section runs' : 'sections run'} over 350 words, which buries the answer inside the passage.`,
    { todo: 'Split long sections with sub-headings so each passage carries one idea.' }
  );

  const format = audit.check('answers', 'Extractable formatting', 'high', {
    help: 'Lists and tables are quoted disproportionately often, because they survive extraction without losing meaning.',
  });
  format.assert(
    geo.lists > 0 || geo.tables > 0,
    `The page contains ${geo.lists} ${geo.lists === 1 ? 'list' : 'lists'} and ${geo.tables} ${geo.tables === 1 ? 'table' : 'tables'}.`,
    'The page has no lists or tables. Prose-only pages are quoted less often, because a model has to paraphrase rather than lift.',
    { todo: 'Convert at least one comparison or sequence into a list or table.' }
  );
  format.assert(
    geo.questionHeadings.length > 0,
    `${geo.questionHeadings.length} ${geo.questionHeadings.length === 1 ? 'heading is' : 'headings are'} phrased as a question or direct intent.`,
    'No heading is phrased the way a person would ask the question.',
    { todo: 'Rewrite some H2s as the questions readers actually type, then answer them immediately underneath.' }
  );
  format.assert(
    doc.avgSentenceWords <= 25,
    `Average sentence length of ${Math.round(doc.avgSentenceWords)} words stays extractable.`,
    `Average sentence length is ${Math.round(doc.avgSentenceWords)} words; long sentences get truncated or paraphrased away.`,
    { todo: 'Shorten sentences so individual claims survive extraction intact.' }
  );

  const depth = audit.check('answers', 'Answer depth', 'high');
  if (doc.wordCount < 300) {
    depth.fail(`${doc.wordCount} words is too thin to be selected over a competing source.`, { todo: 'Expand the page to cover the question and its obvious follow-ups.' });
  } else if (doc.wordCount < 700) {
    depth.warn(`${doc.wordCount} words covers the basics but leaves follow-up questions to a competitor.`, { todo: 'Add the adjacent questions a reader would ask next.' });
  } else {
    depth.ok(`${doc.wordCount} words is enough to cover the topic and its follow-ups.`);
  }
}

function evidenceChecks(audit, { geo }) {
  // The three strongest levers in the GEO paper, in descending measured effect.
  const stats = audit.check('evidence', 'Statistics', 'critical', {
    help: 'The single most effective content change measured in the GEO study. Concrete figures give a model something specific to cite.',
  });
  if (geo.statistics.count === 0) {
    stats.fail('No statistics were found. Pages without concrete figures are markedly less likely to be cited.', {
      todo: 'Add specific, sourced figures — percentages, counts, currency amounts — to the claims you most want quoted.',
    });
  } else if (geo.statistics.count < 3) {
    stats.warn(`Only ${geo.statistics.count} ${geo.statistics.count === 1 ? 'passage contains' : 'passages contain'} a statistic (${geo.statistics.samples.slice(0, 3).join(', ')}).`, {
      todo: 'Support more of your key claims with concrete figures.',
    });
  } else {
    stats.ok(`${geo.statistics.count} passages carry statistics (${geo.statistics.samples.slice(0, 4).join(', ')}).`);
  }

  const quotes = audit.check('evidence', 'Quotations', 'critical', {
    help: 'Quoting a credible source was among the strongest measured levers — it gives the model an attributable statement to reuse. It only counts if the markup says it is a quote.',
  });

  const q = geo.quotations;
  quotes.assert(
    q.marked > 0,
    `${q.marked} quoted ${q.marked === 1 ? 'passage is' : 'passages are'} marked up (${q.blockquotes} blockquote, ${q.inlineQuotes} <q>, ${q.quotedPassages} in quotation marks).`,
    'No marked-up quotations were found. Text that reads as a quote but carries no <blockquote> or quotation marks is indistinguishable from ordinary copy to an extractor.',
    { severity: 'fail', todo: 'Quote a named expert, customer or primary source and mark it up with <blockquote> plus a <cite> for the speaker.' }
  );

  const cites = audit.check('evidence', 'Source citations', 'critical', {
    help: 'Outbound citations to primary sources let a model verify the claim it is about to repeat.',
  });
  if (geo.citations.length === 0) {
    cites.fail('The page cites no external sources at all.', {
      todo: 'Link the claims that matter to their primary sources — studies, standards, regulators, official statistics.',
    });
  } else {
    cites.ok(`${geo.citations.length} external ${geo.citations.length === 1 ? 'source is' : 'sources are'} cited.`);
    cites.assert(
      geo.authoritativeCitations.length > 0,
      `${geo.authoritativeCitations.length} ${geo.authoritativeCitations.length === 1 ? 'citation points' : 'citations point'} to authoritative sources (${[...new Set(geo.authoritativeCitations.map((c) => c.host))].slice(0, 3).join(', ')}).`,
      'No citation points to a recognised authority — .gov, .edu, standards bodies, journals or primary research.',
      { todo: 'Cite at least one primary or institutional source rather than only secondary commentary.' }
    );
  }

  const fresh = audit.check('evidence', 'Freshness', 'high', {
    help: 'Answer engines prefer recent sources, and show the date alongside the citation.',
  });
  if (!geo.freshness.date) {
    fresh.warn('No published or modified date is exposed in the markup.', {
      todo: 'Publish datePublished and dateModified in your Article schema and show the date on the page.',
    });
  } else if (geo.freshness.ageDays > 730) {
    fresh.warn(`The content is dated ${geo.freshness.date} (${Math.round(geo.freshness.ageDays / 365)} years old).`, {
      todo: 'Review and refresh the page, then update dateModified — stale dates lose to fresher competitors.',
    });
  } else {
    fresh.ok(`Content is dated ${geo.freshness.date}${geo.freshness.ageDays != null ? ` (${geo.freshness.ageDays} days ago)` : ''}.`);
  }
}

function authorityChecks(audit, { doc, geo, finalUrl }) {
  const entity = audit.check('authority', 'Publisher entity', 'critical', {
    value: geo.entity.node ? `${geo.entity.node.type}: ${geo.entity.node.name || '(unnamed)'}` : null,
    help: 'A model has to know who is making the claim before it will repeat it with attribution.',
  });

  if (!geo.entity.node) {
    entity.fail('No Organization or Person entity is declared in structured data, so the publisher is left to be inferred.', {
      todo: 'Add Organization (or Person) JSON-LD with name, url, logo and sameAs.',
    });
  } else {
    entity.ok(`The publisher is declared as ${geo.entity.node.type}${geo.entity.node.name ? ` "${geo.entity.node.name}"` : ''}.`);
    entity.assert(
      Boolean(geo.entity.node.name),
      'The entity is named.',
      'The declared entity has no name property.',
      { todo: 'Give the Organization entity an explicit name.' }
    );
  }

  entity.assert(
    geo.entity.sameAs.length >= 2,
    `${geo.entity.sameAs.length} sameAs links corroborate the entity across the web.`,
    `Only ${geo.entity.sameAs.length} sameAs ${geo.entity.sameAs.length === 1 ? 'link' : 'links'} declared. sameAs is how a model reconciles your brand with the entity it already knows.`,
    { todo: 'List your official profiles (LinkedIn, Crunchbase, Wikipedia/Wikidata, X) in schema.org sameAs.' }
  );

  const author = audit.check('authority', 'Authorship', 'high', {
    help: 'Named, credentialed authors are a documented trust signal for both search and answer engines.',
  });
  author.assert(
    doc.hasAuthorMarkup,
    'The page identifies an author.',
    'No author is identified on the page.',
    { todo: 'Attribute the page to a named author with visible credentials and an author schema entry.' }
  );

  const contact = audit.check('authority', 'Verifiability', 'low', {
    help: 'Reachable, checkable organisations get cited; anonymous ones get skipped.',
  });
  const internalPaths = doc.internal.map((l) => { try { return new URL(l.href).pathname.toLowerCase(); } catch { return ''; } });
  const hasAbout = internalPaths.some((p) => /(about|who-we-are|company|team)/.test(p));
  const hasContact = internalPaths.some((p) => /(contact|support|get-started|demo)/.test(p));
  contact.assert(hasAbout, 'An about/company page is linked.', 'No about or company page is linked from this page.', {
    todo: 'Link an about page describing who publishes this and why they are credible.',
  });
  contact.assert(hasContact, 'A contact or enquiry route is linked.', 'No contact route is linked from this page.', {
    todo: 'Link a contact page so the organisation is verifiably reachable.',
  });
}

function machineReadableChecks(audit, { doc, geo }) {
  const schema = audit.check('structure', 'Structured data', 'critical', {
    value: geo.schemaTypes.length ? geo.schemaTypes.join(', ') : null,
    help: 'Schema tells a model what kind of thing the page is without it having to guess from prose.',
  });

  if (!geo.schemaTypes.length) {
    schema.fail('No JSON-LD structured data was found.', {
      todo: 'Add JSON-LD for the page type — Article, FAQPage, HowTo, Product or Organization as appropriate.',
    });
  } else {
    schema.ok(`Structured data declares: ${geo.schemaTypes.join(', ')}.`);
    schema.assert(
      geo.hasAnswerSchema || geo.hasArticleSchema,
      'An answer-shaped or article type is declared, which maps cleanly onto how answers are assembled.',
      'No Article, FAQPage, HowTo or QAPage type is declared, so the page has no answer-shaped schema.',
      { todo: 'Add FAQPage or HowTo where the content genuinely takes that shape — not as decoration.' }
    );
  }

  if (doc.jsonLdErrors.length) {
    schema.fail(`${doc.jsonLdErrors.length} JSON-LD ${doc.jsonLdErrors.length === 1 ? 'block is' : 'blocks are'} malformed and silently ignored.`, {
      todo: 'Fix the invalid JSON-LD — malformed structured data is dropped without warning.',
    });
  }

  const semantics = audit.check('structure', 'Semantic HTML', 'high', {
    help: 'Landmark elements tell an extractor which part of the document is the content and which is furniture.',
  });
  const $ = doc.$;
  semantics.assert(
    $('main, article').length > 0,
    'The content is wrapped in a <main> or <article> landmark.',
    'There is no <main> or <article> element, so an extractor has to guess where the content starts and the navigation ends.',
    { todo: 'Wrap the primary content in <main> or <article>.' }
  );
  semantics.assert(
    doc.h1s.length === 1,
    'Exactly one H1 states what the page is about.',
    doc.h1s.length === 0 ? 'There is no H1, so the page has no stated subject.' : `There are ${doc.h1s.length} H1 headings, so the page states several competing subjects.`,
    { todo: 'Use exactly one H1 naming the page subject.' }
  );
  semantics.assert(
    doc.skippedHeadingLevels.length === 0,
    'Heading levels descend without gaps, so the document outline is machine-readable.',
    `${doc.skippedHeadingLevels.length} heading ${doc.skippedHeadingLevels.length === 1 ? 'level is' : 'levels are'} skipped, which breaks the outline an extractor builds.`,
    { todo: 'Use heading levels in order — H2 before H3 — so the outline parses.' }
  );

  const media = audit.check('structure', 'Described media', 'low', {
    help: 'Alt text is the only description of an image an answer engine receives.',
  });
  if (!doc.images.length) {
    media.info('The page has no images.');
  } else {
    media.assert(
      doc.imagesMissingAlt.length === 0,
      `All ${doc.images.length} images carry alt text.`,
      `${doc.imagesMissingAlt.length} of ${doc.images.length} images have no alt attribute, so their content is invisible to an answer engine.`,
      { todo: 'Describe every meaningful image in alt text.' }
    );
  }
}

// ---- helpers ---------------------------------------------------------------

function collectJsonLd($) {
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      flatten(JSON.parse($(el).text()), nodes);
    } catch { /* malformed blocks are reported separately */ }
  });
  return nodes;
}

function flatten(node, out) {
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return; }
  if (node && typeof node === 'object') {
    out.push(node);
    if (Array.isArray(node['@graph'])) for (const n of node['@graph']) flatten(n, out);
  }
}

const typeString = (t) => (Array.isArray(t) ? t.join('/') : typeof t === 'string' ? t : '');

function extractJsonLdDates($) {
  const nodes = collectJsonLd($);
  let published = null;
  let modified = null;
  for (const n of nodes) {
    if (typeof n.datePublished === 'string' && (!published || n.datePublished > published)) published = n.datePublished;
    if (typeof n.dateModified === 'string' && (!modified || n.dateModified > modified)) modified = n.dateModified;
  }
  return { published, modified };
}
