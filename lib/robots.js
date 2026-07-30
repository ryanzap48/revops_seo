// lib/robots.js
// Minimal robots.txt rule matching for the `*` and `googlebot` groups. Shared by
// the single-page crawlability check and the site crawler, which must not fetch
// a URL the site has asked crawlers to leave alone.

/**
 * @returns {string|false} the matching Disallow pattern, or false when crawlable.
 */
export function robotsDisallows(text, pathWithQuery) {
  const lines = String(text || '').split(/\r?\n/);
  let inGroup = false;
  const rules = [];

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      inGroup = value === '*' || /googlebot/i.test(value);
      continue;
    }
    if (!inGroup) continue;
    if (key === 'disallow' || key === 'allow') rules.push({ type: key, value });
  }

  // Longest match wins; Allow beats Disallow at equal specificity, per the spec.
  let best = null;
  for (const rule of rules) {
    if (rule.type === 'disallow' && rule.value === '') continue;
    if (!robotsPathMatch(rule.value, pathWithQuery)) continue;
    const specificity = rule.value.replace(/\*/g, '').length;
    if (!best || specificity > best.specificity || (specificity === best.specificity && rule.type === 'allow')) {
      best = { ...rule, specificity };
    }
  }

  return best && best.type === 'disallow' ? best.value : false;
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
