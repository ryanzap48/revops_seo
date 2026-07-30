// lib/text.js
// Text analytics: tokenising, stop words, sentence splitting, keyword extraction
// (1–3 word phrases with placement flags), language guessing, and a heuristic
// text-issue scan.

export const STOP_WORDS = new Set(`
a about above after again against all almost also am an and another any are aren't as at
be because been before being below between both but by
can cannot can't could couldn't
did didn't do does doesn't doing don't down during
each either else etc even ever every
few for from further
get got
had hadn't has hasn't have haven't having he her here hers herself him himself his how however
i if in into is isn't it its itself i'd i'll i'm i've
just
let's like
may me might more most much must my myself
neither no nor not now
of off on once one only or other others ought our ours ourselves out over own
per
rather really
said same shall she should shouldn't since so some still such
than that that's the their theirs them themselves then there these they they're this those though through to too
under until up upon us use used using
very
was wasn't we well were weren't what when where whether which while who whom why will with within without won't would wouldn't
yet you your yours yourself yourselves you're you'll
`.trim().split(/\s+/));

// Small stop-word fingerprints used only to guess the document language.
const LANG_MARKERS = {
  en: ['the', 'and', 'of', 'to', 'in', 'is', 'that', 'for', 'with', 'you', 'are', 'this'],
  de: ['der', 'die', 'und', 'den', 'von', 'ist', 'das', 'nicht', 'mit', 'sich', 'ein', 'für'],
  fr: ['les', 'des', 'est', 'une', 'que', 'pour', 'dans', 'sur', 'pas', 'plus', 'nous', 'avec'],
  es: ['que', 'los', 'las', 'una', 'por', 'con', 'para', 'del', 'como', 'más', 'este', 'sus'],
  it: ['che', 'per', 'con', 'del', 'una', 'sono', 'nel', 'alla', 'come', 'più', 'anche', 'dei'],
  pt: ['que', 'não', 'uma', 'para', 'com', 'dos', 'como', 'mais', 'sua', 'pelo', 'você', 'são'],
  nl: ['het', 'een', 'van', 'niet', 'zijn', 'met', 'voor', 'aan', 'die', 'dat', 'ook', 'maar'],
};

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

export function tokenize(text) {
  return (String(text).toLowerCase().match(WORD_RE) || []).map((w) => w.replace(/^[-'’]+|[-'’]+$/g, '')).filter(Boolean);
}

export function wordCount(text) {
  return tokenize(text).length;
}

export function splitSentences(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+(?=[^a-z])/)
    .map((s) => s.trim())
    .filter((s) => tokenize(s).length > 0);
}

export function stopWordRatio(tokens) {
  if (!tokens.length) return 0;
  const stops = tokens.filter((t) => STOP_WORDS.has(t)).length;
  return (stops / tokens.length) * 100;
}

export function detectLanguage(text) {
  const tokens = tokenize(text).slice(0, 4000);
  if (tokens.length < 20) return { code: null, confidence: 0 };

  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);

  const scores = Object.entries(LANG_MARKERS).map(([code, markers]) => {
    const hits = markers.reduce((sum, m) => sum + (freq.get(m) || 0), 0);
    return { code, score: hits / tokens.length };
  });
  scores.sort((a, b) => b.score - a.score);

  const [best, second] = scores;
  if (!best.score) return { code: null, confidence: 0 };
  const margin = second ? best.score - second.score : best.score;
  return { code: best.code, confidence: Math.min(1, margin * 25 + best.score * 5) };
}

// Heuristic text-quality scan. This is deliberately not a spell checker — it
// flags mechanical mistakes that can be detected without a dictionary, so every
// hit is verifiable by eye.
export function findTextIssues(paragraphs) {
  const issues = [];
  const seen = new Set();
  const push = (type, excerpt, note) => {
    const key = `${type}|${excerpt}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ type, excerpt, note });
  };

  const ABBREV = /\b(?:mr|mrs|ms|dr|prof|inc|ltd|llc|co|vs|etc|e\.g|i\.e|no|fig|approx|dept|est|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|u\.s|u\.k)\.$/i;

  for (const p of paragraphs) {
    // Doubled word ("the the", "of of").
    for (const m of p.matchAll(/\b(\p{L}{2,})\s+\1\b/giu)) {
      if (/^(that|had|very|no|so|out|blah)$/i.test(m[1])) continue;
      push('Repeated word', excerptAround(p, m.index, m[0].length), `"${m[1]} ${m[1]}"`);
    }

    // Missing space after sentence punctuation, excluding URLs, decimals, abbreviations.
    for (const m of p.matchAll(/(\p{Ll}{2,})([.!?])(\p{Lu}\p{Ll}{2,})/gu)) {
      const before = m[1] + m[2];
      if (ABBREV.test(before)) continue;
      if (/https?|www|\.(com|org|net|io|co|health|ai)$/i.test(m[1])) continue;
      push('Missing space', excerptAround(p, m.index, m[0].length), `after "${m[2]}"`);
    }

    // Space before punctuation.
    for (const m of p.matchAll(/\p{L}\s+([,;:!?])(?:\s|$)/gu)) {
      push('Spacing before punctuation', excerptAround(p, m.index, m[0].length), `stray space before "${m[1]}"`);
    }

    // Doubled punctuation that is not an ellipsis.
    for (const m of p.matchAll(/([,;:])\1+|\?{3,}|!{3,}/g)) {
      push('Duplicate punctuation', excerptAround(p, m.index, m[0].length), m[0]);
    }

    // Run-together words are impossible to detect reliably, but absurdly long
    // tokens almost always mean a missing space or a broken template.
    for (const m of p.matchAll(/\b\p{L}{31,}\b/gu)) {
      push('Suspiciously long word', excerptAround(p, m.index, m[0].length), `${m[0].length} characters`);
    }

    // Unrendered template placeholders.
    for (const m of p.matchAll(/\{\{[^}]{1,60}\}\}|%[A-Z_]{3,}%|\$\{[^}]{1,60}\}/g)) {
      push('Unrendered placeholder', excerptAround(p, m.index, m[0].length), m[0]);
    }
  }

  return issues;
}

function excerptAround(text, index, length, pad = 34) {
  const start = Math.max(0, index - pad);
  const end = Math.min(text.length, index + length + pad);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

// ---- Keyword extraction ----------------------------------------------------

const NOISE = new Set(['click', 'here', 'read', 'more', 'learn', 'home', 'page', 'menu', 'skip', 'content', 'toggle', 'close', 'open']);

function isCandidate(tokens) {
  if (!tokens.length) return false;
  if (STOP_WORDS.has(tokens[0]) || STOP_WORDS.has(tokens[tokens.length - 1])) return false;
  if (tokens.every((t) => NOISE.has(t))) return false;
  if (tokens.some((t) => t.length < 2)) return false;
  if (tokens.every((t) => /^\d+$/.test(t))) return false;
  return true;
}

/**
 * Rank the phrases a page is actually "about".
 * Frequency is combined with a phrase-length bonus and a placement bonus so that
 * a term in the title/H1 outranks an equally frequent term buried in the footer.
 *
 * Returns the token count the densities are based on, so the UI can state the
 * denominator instead of leaving the reader to guess at it.
 */
export function extractKeywords(text, { title = '', description = '', headings = [], url = '', limit = 25 } = {}) {
  const tokens = tokenize(text);
  const total = tokens.length || 1;
  const counts = new Map();

  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const gram = tokens.slice(i, i + n);
      if (!isCandidate(gram)) continue;
      if (n > 1 && gram.filter((t) => STOP_WORDS.has(t)).length > n - 2) continue;
      const phrase = gram.join(' ');
      const entry = counts.get(phrase) || { phrase, words: n, count: 0 };
      entry.count++;
      counts.set(phrase, entry);
    }
  }

  const titleL = title.toLowerCase();
  const descL = description.toLowerCase();
  const headingsL = headings.map((h) => (h.text || '').toLowerCase());
  const urlL = decodeURIComponent(url).toLowerCase().replace(/[-_/]+/g, ' ');

  const scored = [];
  for (const entry of counts.values()) {
    if (entry.words === 1 && entry.count < 2) continue;
    if (entry.words > 1 && entry.count < 2) continue;

    const inTitle = titleL.includes(entry.phrase);
    const inDescription = descL.includes(entry.phrase);
    const inHeadings = headingsL.filter((h) => h.includes(entry.phrase)).length;
    const inUrl = urlL.includes(entry.phrase);

    const placement = (inTitle ? 3 : 0) + (inDescription ? 1.5 : 0) + Math.min(inHeadings, 4) * 1.2 + (inUrl ? 1 : 0);
    const lengthBonus = entry.words === 1 ? 1 : entry.words === 2 ? 1.7 : 2.1;
    const score = entry.count * lengthBonus + placement * 2;

    scored.push({
      keyword: entry.phrase,
      words: entry.words,
      count: entry.count,
      density: (entry.count * entry.words) / total * 100,
      inTitle,
      inDescription,
      inHeadings,
      inUrl,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score || b.count - a.count);

  // Drop shorter phrases that are fully contained in a stronger, longer phrase
  // with a similar count — they are the same concept counted twice.
  const kept = [];
  for (const cand of scored) {
    const subsumed = kept.some(
      (k) => k.words > cand.words && k.keyword.includes(cand.keyword) && cand.count <= k.count * 1.3
    );
    if (!subsumed) kept.push(cand);
    if (kept.length >= limit) break;
  }

  return {
    tokenCount: tokens.length,
    list: kept.map((k) => ({ ...k, density: Math.round(k.density * 100) / 100, score: Math.round(k.score * 10) / 10 })),
  };
}
