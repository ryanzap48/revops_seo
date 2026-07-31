// lib/robots.js
// robots.txt parsing and rule matching.
//
// This needs to be per-user-agent rather than just "*", because the whole point
// of the GEO crawler-access check is that different bots get different answers:
// a site can legitimately block GPTBot (training) while allowing OAI-SearchBot
// (retrieval), and only the second decides whether it can be cited in answers.
//
// Group selection follows Google's spec: the most specific matching user-agent
// group wins outright, and "*" applies only when no specific group matches.

/**
 * @returns {{groups: Array<{agents: string[], rules: Array<{type:string, value:string}>}>, sitemaps: string[]}}
 */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let expectingAgents = false;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;

    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === 'sitemap') { sitemaps.push(value); continue; }

    if (key === 'user-agent') {
      // Consecutive user-agent lines share one block of rules.
      if (!current || !expectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        expectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue;
    expectingAgents = false;
    if (key === 'disallow' || key === 'allow') current.rules.push({ type: key, value });
    else if (key === 'crawl-delay') current.rules.push({ type: 'crawl-delay', value });
  }

  return { groups, sitemaps };
}

/** The rules that apply to `userAgent`, or null when the file says nothing about it. */
export function rulesFor(parsed, userAgent) {
  const ua = String(userAgent || '*').toLowerCase();

  // Longest matching agent token wins, so "claudebot" beats a generic "claude".
  let best = null;
  let bestLength = -1;
  let wildcard = null;

  for (const group of parsed.groups) {
    for (const agent of group.agents) {
      if (agent === '*') { wildcard = wildcard || group; continue; }
      if (ua === agent || ua.startsWith(agent) || agent.startsWith(ua)) {
        if (agent.length > bestLength) { best = group; bestLength = agent.length; }
      }
    }
  }

  if (best) return { rules: best.rules, matchedAgent: best.agents.find((a) => a !== '*') || '*', specific: true };
  if (wildcard) return { rules: wildcard.rules, matchedAgent: '*', specific: false };
  return null;
}

/**
 * Is `path` crawlable by `userAgent`?
 * @returns {{allowed: boolean, rule: string|null, matchedAgent: string|null, specific: boolean, crawlDelay: number|null}}
 */
export function isAllowed(parsed, path, userAgent = '*') {
  const group = rulesFor(parsed, userAgent);
  if (!group) return { allowed: true, rule: null, matchedAgent: null, specific: false, crawlDelay: null };

  const delayRule = group.rules.find((r) => r.type === 'crawl-delay');
  const crawlDelay = delayRule ? Number(delayRule.value) || null : null;

  let best = null;
  for (const rule of group.rules) {
    if (rule.type === 'crawl-delay') continue;
    if (rule.type === 'disallow' && rule.value === '') continue; // "Disallow:" means allow all
    if (!robotsPathMatch(rule.value, path)) continue;

    const specificity = rule.value.replace(/\*/g, '').length;
    // Longest match wins; Allow beats Disallow at equal length, per the spec.
    if (!best || specificity > best.specificity || (specificity === best.specificity && rule.type === 'allow')) {
      best = { ...rule, specificity };
    }
  }

  return {
    allowed: !best || best.type === 'allow',
    rule: best && best.type === 'disallow' ? best.value : null,
    matchedAgent: group.matchedAgent,
    specific: group.specific,
    crawlDelay,
  };
}

/**
 * Back-compat helper for the SEO crawlability check.
 * @returns {string|false} the matching Disallow pattern, or false when crawlable.
 */
export function robotsDisallows(text, pathWithQuery) {
  const parsed = parseRobots(text);
  for (const agent of ['googlebot', '*']) {
    const verdict = isAllowed(parsed, pathWithQuery, agent);
    if (!verdict.allowed) return verdict.rule;
  }
  return false;
}

export function robotsPathMatch(pattern, path) {
  if (!pattern) return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}
