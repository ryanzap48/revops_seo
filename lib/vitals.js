// lib/vitals.js
// Core Web Vitals from the Chrome UX Report — real measurements from real Chrome
// users, which is what Google actually ranks on. Everything else in this tool is
// inspection of the page source; this is the one signal that comes from the
// field, so it cannot be inferred and must be fetched.
//
// The CrUX API requires a key (it answers 403 without one), and PageSpeed
// Insights is not a keyless substitute — its anonymous quota is a shared global
// pool that is routinely exhausted. So without a key this returns "unavailable"
// and the category is excluded from scoring rather than guessed at.
//
// Get a key: https://console.cloud.google.com/apis/credentials — enable the
// "Chrome UX Report API" — then set CRUX_API_KEY.

import { requestOnce } from './http.js';

// Overridable so the integration can be pointed at a mock or a corporate proxy.
const ENDPOINT = process.env.CRUX_ENDPOINT || 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';

// Google's published Core Web Vitals thresholds. `good` is the p75 at or below
// which a page passes; above `poor` it fails; between the two it needs work.
export const THRESHOLDS = {
  lcp:  { good: 2500, poor: 4000, unit: 'ms', label: 'Largest Contentful Paint', core: true },
  inp:  { good: 200,  poor: 500,  unit: 'ms', label: 'Interaction to Next Paint', core: true },
  cls:  { good: 0.1,  poor: 0.25, unit: '',   label: 'Cumulative Layout Shift', core: true },
  fcp:  { good: 1800, poor: 3000, unit: 'ms', label: 'First Contentful Paint', core: false },
  ttfb: { good: 800,  poor: 1800, unit: 'ms', label: 'Time to First Byte', core: false },
};

const METRIC_KEYS = {
  largest_contentful_paint: 'lcp',
  interaction_to_next_paint: 'inp',
  cumulative_layout_shift: 'cls',
  first_contentful_paint: 'fcp',
  experimental_time_to_first_byte: 'ttfb',
};

export const cruxKey = () => process.env.CRUX_API_KEY || process.env.PAGESPEED_API_KEY || null;
export const cruxConfigured = () => Boolean(cruxKey());

export function rate(metric, value) {
  const t = THRESHOLDS[metric];
  if (!t || value == null) return null;
  if (value <= t.good) return 'good';
  if (value <= t.poor) return 'needs-improvement';
  return 'poor';
}

export function formatValue(metric, value) {
  if (value == null) return '—';
  return THRESHOLDS[metric]?.unit === 'ms'
    ? (value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`)
    : Number(value).toFixed(2);
}

/**
 * Query CrUX for one URL or one origin.
 * @param {{url?:string, origin?:string, formFactor?:string, apiKey?:string, timeout?:number}} opts
 * @returns {Promise<object>} `{available:true, metrics}` or `{available:false, reason}`
 */
export async function fetchFieldData(opts = {}) {
  const apiKey = opts.apiKey ?? cruxKey();
  if (!apiKey) {
    return { available: false, reason: 'no-key', message: 'No CrUX API key is configured, so real-user Core Web Vitals cannot be read.' };
  }

  const formFactor = opts.formFactor || process.env.CRUX_FORM_FACTOR || 'PHONE';
  const target = opts.url ? { url: opts.url } : { origin: opts.origin };
  if (!target.url && !target.origin) return { available: false, reason: 'no-target', message: 'No URL or origin supplied.' };

  let res;
  try {
    res = await requestOnce(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: { ...target, formFactor },
      timeout: opts.timeout ?? 10000,
      maxBytes: 512 * 1024,
    });
  } catch (err) {
    return { available: false, reason: 'network', message: `Could not reach the CrUX API (${err.message}).` };
  }

  let payload;
  try {
    payload = JSON.parse(res.body.toString('utf8'));
  } catch {
    return { available: false, reason: 'bad-response', message: 'The CrUX API returned a response that could not be parsed.' };
  }

  if (res.status !== 200) {
    const message = payload?.error?.message || `HTTP ${res.status}`;
    // 404 is the normal answer for a page with too little traffic to report on,
    // not a failure — most of the web is below CrUX's reporting threshold.
    if (res.status === 404) return { available: false, reason: 'no-data', message: 'Chrome UX Report has no data for this address — it needs a minimum amount of real traffic.' };
    if (res.status === 403) return { available: false, reason: 'forbidden', message: `CrUX rejected the API key: ${message}` };
    if (res.status === 429) return { available: false, reason: 'quota', message: 'The CrUX API quota for this key is exhausted.' };
    return { available: false, reason: 'error', message: `CrUX API error: ${message}` };
  }

  const record = payload?.record;
  if (!record?.metrics) return { available: false, reason: 'no-data', message: 'Chrome UX Report returned no metrics for this address.' };

  const metrics = {};
  for (const [apiName, key] of Object.entries(METRIC_KEYS)) {
    const raw = record.metrics[apiName];
    if (!raw) continue;
    const p75 = Number(raw.percentiles?.p75);
    if (!Number.isFinite(p75)) continue;

    // The histogram is always three buckets: good, needs improvement, poor.
    const density = (raw.histogram || []).map((b) => Number(b.density) || 0);
    metrics[key] = {
      key,
      label: THRESHOLDS[key].label,
      core: THRESHOLDS[key].core,
      p75,
      display: formatValue(key, p75),
      rating: rate(key, p75),
      good: pct(density[0]),
      needsImprovement: pct(density[1]),
      poor: pct(density[2]),
      threshold: { good: THRESHOLDS[key].good, poor: THRESHOLDS[key].poor, unit: THRESHOLDS[key].unit },
    };
  }

  if (!Object.keys(metrics).length) {
    return { available: false, reason: 'no-data', message: 'Chrome UX Report returned a record with no usable metrics.' };
  }

  return {
    available: true,
    scope: target.url ? 'url' : 'origin',
    subject: target.url || target.origin,
    formFactor,
    collectionPeriod: formatPeriod(record.collectionPeriod),
    metrics,
    // A page passes Core Web Vitals only when all three core metrics are good.
    passes: ['lcp', 'inp', 'cls'].every((k) => !metrics[k] || metrics[k].rating === 'good'),
  };
}

/**
 * Field data for a page, falling back to the origin when the individual URL has
 * too little traffic — which is the common case for all but the busiest pages.
 */
export async function fetchPageFieldData(pageUrl, originFallback = null) {
  if (!cruxConfigured()) return { available: false, reason: 'no-key', message: 'No CrUX API key is configured, so real-user Core Web Vitals cannot be read.' };

  const byUrl = await fetchFieldData({ url: pageUrl });
  if (byUrl.available) return byUrl;
  if (byUrl.reason !== 'no-data') return byUrl; // a key or network problem will not improve at origin level

  if (originFallback?.available) return { ...originFallback, fellBackFromUrl: true };
  const origin = new URL(pageUrl).origin;
  const byOrigin = await fetchFieldData({ origin });
  return byOrigin.available ? { ...byOrigin, fellBackFromUrl: true } : byUrl;
}

const pct = (density) => Math.round((Number(density) || 0) * 1000) / 10;

function formatPeriod(period) {
  if (!period?.firstDate || !period?.lastDate) return null;
  const iso = (d) => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
  return { from: iso(period.firstDate), to: iso(period.lastDate) };
}
