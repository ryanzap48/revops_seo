/* app.js — renders the audit report returned by /api/analyze. */

const $ = (sel) => document.querySelector(sel);
const el = {
  input: $('#url'), run: $('#run'), error: $('#error'), loading: $('#loading'),
  loadingText: $('#loading-text'), loadingBar: $('#loading-bar'), results: $('#results'),
  gauge: $('#gauge-fill'), scoreNum: $('#score-num'), scoreVerdict: $('#score-verdict'),
  errors: $('#count-errors'), warnings: $('#count-warnings'), passed: $('#count-passed'),
  meters: $('#hero-meters'), factsheet: $('#factsheet'), analyzedAt: $('#analyzed-at'),
  todos: $('#todos'), todoPanel: $('#todo-panel'), checks: $('#checks'),
  elements: $('#elements'), keywords: $('#keywords'), tabs: $('#tabs'), export: $('#export'),

  modeSwitch: $('#mode-switch'), urlLabel: $('#url-label'), pagesField: $('#pages-field'), maxPages: $('#max-pages'),
  backStrip: $('#back-strip'), backToSite: $('#back-to-site'),
  siteResults: $('#site-results'), siteGauge: $('#site-gauge-fill'),
  siteScoreNum: $('#site-score-num'), siteScoreVerdict: $('#site-score-verdict'),
  siteStrong: $('#site-count-strong'), siteFair: $('#site-count-fair'), siteWeak: $('#site-count-weak'),
  siteMeters: $('#site-meters'), siteFactsheet: $('#site-factsheet'), siteCrawledAt: $('#site-crawled-at'),
  siteTabs: $('#site-tabs'), siteTodos: $('#site-todos'), siteIssues: $('#site-issues'),
  sitePages: $('#site-pages'), siteExport: $('#site-export'),
};

const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 68;
let lastReport = null;
let lastSiteReport = null;
let mode = 'page';

const PROGRESS_STEPS = [
  'Fetching the page, robots.txt, sitemap, host variants and TLS handshake…',
  'Parsing the DOM: headings, paragraphs, media, links and meta tags…',
  'Running 32 checks across meta data, content, structure, links and server config…',
  'Scoring findings and extracting the keyword profile…',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Bars and arcs use the brand tones; text uses darker variants so small type
// stays legible on white.
function scoreColor(score) {
  if (score === null || score === undefined) return 'var(--line)';
  if (score >= 80) return 'var(--green)';
  if (score >= 60) return 'var(--amber)';
  return 'var(--red)';
}

function scoreInk(score) {
  if (score === null || score === undefined) return 'var(--ink-faint)';
  if (score >= 80) return 'var(--green-ink)';
  if (score >= 60) return 'var(--amber-ink)';
  return 'var(--red-ink)';
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Shorten a URL for table display: keep the path, drop the origin when internal. */
function shortUrl(href, origin) {
  try {
    const u = new URL(href);
    if (origin && u.origin === origin) return (u.pathname + u.search + u.hash) || '/';
    return u.host + (u.pathname === '/' ? '' : u.pathname) + u.search;
  } catch {
    return href;
  }
}

function fileName(src) {
  if (!src) return '(no source)';
  try {
    const u = new URL(src);
    const name = u.pathname.split('/').filter(Boolean).pop() || u.host;
    return decodeURIComponent(name).slice(0, 60);
  } catch {
    return String(src).slice(0, 60);
  }
}

function tag(text, kind = 'neutral') {
  return `<span class="tag ${kind}">${esc(text)}</span>`;
}

function details(title, count, body, { muted = false, open = false } = {}) {
  return `
    <details class="el"${open ? ' open' : ''}>
      <summary><span class="el-caret">▶</span>${esc(title)}<span class="el-count${muted ? ' muted' : ''}">${esc(count)}</span></summary>
      <div class="el-body">${body}</div>
    </details>`;
}

function table(headers, rows) {
  if (!rows.length) return '<p class="empty-state">Nothing found on this page.</p>';
  return `<div class="el-scroll"><table class="grid">
    <thead><tr>${headers.map((h) => `<th${h.align === 'right' ? ' class="num"' : ''}>${esc(h.label ?? h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table></div>`;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

function startLoading(indeterminate = true) {
  el.error.hidden = true;
  el.run.disabled = true;
  el.loading.hidden = false;
  el.loadingBar.classList.toggle('is-determinate', !indeterminate);
  el.loadingBar.querySelector('i').style.width = indeterminate ? '' : '0%';
}

function stopLoading() {
  el.run.disabled = false;
  el.loading.hidden = true;
}

function showError(message) {
  el.error.textContent = message;
  el.error.hidden = false;
}

async function runAudit(targetUrl, { keepSiteReport = false } = {}) {
  const url = (targetUrl ?? el.input.value).trim();
  if (!url) return showError('Enter a URL to check.');

  startLoading(true);
  el.results.hidden = true;
  if (!keepSiteReport) el.siteResults.hidden = true;

  let step = 0;
  el.loadingText.textContent = PROGRESS_STEPS[0];
  const ticker = setInterval(() => {
    step = Math.min(step + 1, PROGRESS_STEPS.length - 1);
    el.loadingText.textContent = PROGRESS_STEPS[step];
  }, 1400);

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'The audit failed.');
    lastReport = data;
    el.siteResults.hidden = true;
    el.backStrip.hidden = !keepSiteReport;
    render(data);
  } catch (err) {
    showError(err.message);
  } finally {
    clearInterval(ticker);
    stopLoading();
  }
}

// ---------------------------------------------------------------------------
// Site crawl: start a job, poll it, render the aggregate
// ---------------------------------------------------------------------------

async function runCrawl() {
  const url = el.input.value.trim();
  if (!url) return showError('Enter a site to crawl.');

  const maxPages = Number(el.maxPages.value);
  startLoading(false);
  el.results.hidden = true;
  el.siteResults.hidden = true;
  el.loadingText.textContent = 'Reading robots.txt and the sitemap, then crawling…';

  try {
    const res = await fetch('/api/crawl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, maxPages }),
    });
    const started = await res.json();
    if (!res.ok) throw new Error(started.error || 'The crawl could not be started.');

    const result = await pollCrawl(started.jobId);
    lastSiteReport = result;
    renderSite(result);
  } catch (err) {
    showError(err.message);
  } finally {
    stopLoading();
  }
}

function pollCrawl(jobId) {
  return new Promise((resolve, reject) => {
    let misses = 0;

    const tick = async () => {
      try {
        const res = await fetch(`/api/crawl/${jobId}`);
        const job = await res.json();
        if (!res.ok) throw new Error(job.error || 'Lost track of that crawl.');

        const { crawled = 0, discovered = 0, target = 1 } = job.progress || {};
        el.loadingBar.querySelector('i').style.width = `${Math.min(100, (crawled / Math.max(1, target)) * 100)}%`;
        el.loadingText.textContent = `Audited ${crawled} of ${target} pages · ${discovered} URLs discovered`;

        if (job.status === 'done') return resolve(job.result);
        if (job.status === 'error') return reject(new Error(job.error || 'The crawl failed.'));
        setTimeout(tick, 800);
      } catch (err) {
        // Tolerate a couple of dropped polls before giving up on the job.
        if (++misses > 3) return reject(err);
        setTimeout(tick, 1200);
      }
    };

    tick();
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const VITAL_ABBR = { lcp: 'LCP', inp: 'INP', cls: 'CLS', fcp: 'FCP', ttfb: 'TTFB' };
const RATING_LABEL = { good: 'Good', 'needs-improvement': 'Needs improvement', poor: 'Poor' };
const RATING_INK = { good: 'var(--green-ink)', 'needs-improvement': 'var(--amber-ink)', poor: 'var(--red-ink)' };

/** Field-data panel, shared by the page report and the site report. */
function renderVitalsInto(panel, noteEl, bodyEl, vitals) {
  if (!vitals) { panel.hidden = true; return; }
  panel.hidden = false;

  if (!vitals.available) {
    noteEl.textContent = 'not available';
    bodyEl.innerHTML = `<div class="vitals-unavailable">
      <p>${esc(vitals.message || 'No field data available.')}</p>
      ${vitals.reason === 'no-key'
        ? `<p style="margin-top:10px">Enable the <em>Chrome UX Report API</em> in Google Cloud, create a key, and set <code>CRUX_API_KEY</code>. Until then this category is reported but left out of the score rather than estimated.</p>`
        : ''}
    </div>`;
    return;
  }

  const order = ['lcp', 'inp', 'cls', 'fcp', 'ttfb'];
  const metrics = order.map((k) => vitals.metrics[k]).filter(Boolean);

  noteEl.textContent = [
    vitals.scope === 'origin' ? 'whole origin' : 'this URL',
    vitals.formFactor === 'PHONE' ? 'mobile' : String(vitals.formFactor || '').toLowerCase(),
    vitals.collectionPeriod ? `${vitals.collectionPeriod.from} → ${vitals.collectionPeriod.to}` : null,
  ].filter(Boolean).join(' · ');

  bodyEl.innerHTML = `
    <div class="vitals-grid">
      ${metrics.map((m) => `
        <div class="vital">
          <div class="vital-label"><span class="abbr">${VITAL_ABBR[m.key]}</span>${esc(m.label)}</div>
          <div class="vital-value" style="color:${RATING_INK[m.rating]}">${esc(m.display)}</div>
          <div class="vital-target">${esc(RATING_LABEL[m.rating])} · good is ${m.threshold.unit === 'ms' ? `${m.threshold.good} ms` : m.threshold.good} or less</div>
          <div class="vital-bar">
            <i class="good" style="width:${m.good}%"></i><i class="ni" style="width:${m.needsImprovement}%"></i><i class="poor" style="width:${m.poor}%"></i>
          </div>
          <div class="vital-split"><b>${m.good}% good</b><b>${m.needsImprovement}% NI</b><b>${m.poor}% poor</b></div>
        </div>`).join('')}
    </div>
    <div class="vitals-verdict ${vitals.passes ? 'pass' : 'fail'}">
      ${vitals.passes
        ? 'Passes the Core Web Vitals assessment — LCP, INP and CLS are all good.'
        : 'Does not pass the Core Web Vitals assessment. All three of LCP, INP and CLS must be good.'}
      ${vitals.fellBackFromUrl ? ' This page has too little traffic for its own record, so origin-level data is shown.' : ''}
    </div>`;
}

function render(d) {
  renderHero(d);
  renderFactsheet(d);
  renderVitalsInto($('#vitals-panel'), $('#vitals-note'), $('#vitals-body'), d.vitals);
  renderTodos(d);
  renderChecks(d);
  renderElements(d);
  renderKeywords(d);

  el.results.hidden = false;
  el.analyzedAt.textContent = `Checked ${new Date(d.analyzedAt).toLocaleString()}`;
  selectTab(new URLSearchParams(location.search).get('tab') || 'report');
  el.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderHero(d) {
  el.scoreNum.textContent = `${d.score.overall}%`;
  el.scoreNum.style.color = scoreInk(d.score.overall);
  el.scoreVerdict.textContent = d.score.verdict;
  el.gauge.style.stroke = scoreColor(d.score.overall);
  el.gauge.style.strokeDasharray = `${(d.score.overall / 100) * GAUGE_CIRCUMFERENCE} ${GAUGE_CIRCUMFERENCE}`;

  el.errors.textContent = d.score.errors;
  el.warnings.textContent = d.score.warnings;
  el.passed.textContent = d.score.passed;

  el.meters.innerHTML = d.categories.map((c) => {
    const score = c.measured ? c.score : null;
    return `
      <div class="meter${c.measured ? '' : ' is-unmeasured'}">
        <div class="meter-label">${esc(c.label)}<em>weight ${c.measured ? `${c.weight}%` : 'excluded'}</em></div>
        <div class="meter-track"><i style="width:${c.measured ? c.score : 0}%;background:${scoreColor(score)}"></i></div>
        <div class="meter-score" style="color:${scoreInk(score)}">${c.measured ? `${c.score}%` : 'n/a'}</div>
      </div>`;
  }).join('');
}

function renderFactsheet(d) {
  const p = d.page;
  const statusKind = p.statusCode >= 200 && p.statusCode < 300 ? 'ok' : p.statusCode >= 400 ? 'fail' : 'warn';
  const rows = [];
  const add = (label, value, opts = {}) => {
    rows.push(`<div${opts.wide ? ' class="span-2"' : ''}>
      <dt>${esc(label)}</dt><dd${opts.mono ? ' class="mono"' : ''}>${value}</dd></div>`);
  };

  add('Meta title', p.title ? esc(p.title) : `<span class="tag fail">missing</span>`, { wide: true });
  add('Meta description', p.description ? esc(p.description) : `<span class="tag fail">missing</span>`, { wide: true });
  add('URL', `<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url)}</a>`, { wide: true, mono: true });
  add('Status code', `${tag(`${p.statusCode} ${p.statusText}`.trim(), statusKind)}${p.redirectChain.length > 1 ? tag(`${p.redirectChain.length - 1} redirect${p.redirectChain.length > 2 ? 's' : ''}`, 'warn') : ''}`);
  add('Page status', `${tag(p.pageStatus.index ? 'Index' : 'Noindex', p.pageStatus.index ? 'ok' : 'fail')}${tag(p.pageStatus.follow ? 'Follow' : 'Nofollow', p.pageStatus.follow ? 'ok' : 'warn')}`);
  add('Language', p.language.detected
    ? `${tag(p.language.detected.toUpperCase(), 'neutral')}<span class="mono-note">detected · declared ${esc(p.language.declared || 'none')}</span>`
    : `${tag('undetected', 'warn')}`);
  add('Response time', `${(p.responseMs / 1000).toFixed(2)} sec <span class="mono-note">TTFB</span>`);
  add('File size', `${p.fileSizeKb} kB <span class="mono-note">${p.transferKb} kB over the wire${p.compression ? ` · ${esc(p.compression)}` : ''}</span>`);
  add('Word count', String(p.wordCount));
  add('Protocol', `${esc(p.protocol)}${p.tlsVersion ? ` <span class="mono-note">${esc(p.tlsVersion)}</span>` : ''}`);
  add('Server', p.server ? esc(p.server) : '<span class="muted">not disclosed</span>', { mono: true });
  add('Server IP', p.serverIp ? esc(p.serverIp) : '<span class="muted">not resolved</span>', { mono: true });
  add('Charset', esc(p.charset || 'not declared'), { mono: true });
  add('Canonical', p.canonical ? esc(p.canonical) : '<span class="tag warn">none</span>', { wide: true, mono: true });

  if (p.redirectChain.length > 1) {
    add('Redirect chain', p.redirectChain.map((h) => `${tag(h.status, h.status < 300 ? 'ok' : 'warn')}${esc(shortUrl(h.url))}`).join(' <span class="muted">→</span> '), { wide: true, mono: true });
  }

  el.factsheet.innerHTML = rows.join('');
}

function renderTodos(d) {
  if (!d.todos.length) {
    el.todos.innerHTML = `<p class="empty-state"><b>Nothing to fix.</b> Every measurable check on this page passed. Run a full-site crawl to find issues on the other pages.</p>`;
    return;
  }

  el.todos.innerHTML = d.todos.map((t) => `
    <div class="todo-row">
      <div class="todo-action">
        ${esc(t.action)}
        <span class="because"><span class="where">${esc(t.category)} › ${esc(t.check)}</span> — ${esc(t.because)}</span>
      </div>
      <div><span class="imp imp-${t.importance}">${esc(t.importanceLabel)}</span></div>
    </div>`).join('');
}

function renderChecks(d) {
  el.checks.innerHTML = d.categories.map((cat) => {
    const score = cat.measured ? cat.score : null;
    // Open anything that is not clean, so problems are visible without clicking.
    const open = !cat.measured || cat.counts.fail > 0 || cat.counts.warn > 0;

    const body = cat.checks.map((c) => `
      <article class="check">
        <div class="check-head">
          <span class="status-dot ${c.status}"></span>
          <h4>${esc(c.name)}</h4>
          <span class="check-spacer"></span>
          <span class="points">${c.points.earned}/${c.points.max}</span>
          <span class="imp imp-${c.importance}">${esc(c.importanceLabel)}</span>
        </div>
        ${c.value ? `<div class="check-value">${esc(truncate(c.value, 300))}</div>` : ''}
        ${c.help ? `<p class="check-help">${esc(c.help)}</p>` : ''}
        <ul class="findings">
          ${c.findings.map((f) => `<li class="${f.status}">${esc(f.text)}${f.todo && f.status !== 'ok' ? `<span class="fix">${esc(f.todo)}</span>` : ''}</li>`).join('')}
        </ul>
      </article>`).join('');

    return `
      <section class="cat${open ? ' is-open' : ''}">
        <div class="cat-head">
          <span class="cat-caret">▶</span>
          <span class="cat-title">${esc(cat.label)}<em>${cat.checks.length} checks · ${cat.points.earned}/${cat.points.max} points</em></span>
          <div class="cat-track"><i style="width:${cat.measured ? cat.score : 0}%;background:${scoreColor(score)}"></i></div>
          <span class="cat-pct" style="color:${scoreInk(score)}">${cat.measured ? `${cat.score}%` : 'n/a'}</span>
        </div>
        <div class="cat-body">
          ${cat.note ? `<p class="cat-note">${esc(cat.note)}</p>` : ''}
          ${body}
        </div>
      </section>`;
  }).join('');

  el.checks.querySelectorAll('.cat-head').forEach((head) => {
    head.addEventListener('click', () => head.parentElement.classList.toggle('is-open'));
  });
}

function renderElements(d) {
  const e = d.elements;
  const origin = new URL(d.page.url).origin;
  const out = [];

  // Heading outline. The level tally leads, since the outline itself scrolls.
  out.push(details('Heading structure', e.headings.count, `
    <div class="chiplist">${e.headings.byLevel.filter((b) => b.count).map((b) => `<span>H${b.level} × ${b.count}</span>`).join('')}</div>
    <div class="outline">
      ${e.headings.list.map((h) => `
        <div class="outline-row" style="padding-left:${22 + (h.level - 1) * 18}px">
          <span class="lvl${h.level > 3 ? ' deep' : ''}">H${h.level}</span>
          <span class="txt${h.text ? '' : ' blank'}">${h.text ? esc(h.text) : '(empty heading)'}</span>
        </div>`).join('') || '<p class="empty-state">No headings found.</p>'}
    </div>
  `, { open: true }));

  // Paragraphs
  out.push(details('Recognized text paragraphs', e.paragraphs.count, `
    <ul class="blocklist">
      ${e.paragraphs.list.map((p, i) => `<li><span class="idx">${i + 1}</span>${esc(truncate(p, 400))}</li>`).join('') || '<li>No text blocks found.</li>'}
    </ul>`));

  // Text issues
  out.push(details('Text issues', e.textIssues.count || 'None', e.textIssues.count
    ? e.textIssues.list.map((t) => `
        <div class="issue-row">
          <span class="kind">${esc(t.type)}</span><span class="note">${esc(t.note || '')}</span>
          <div class="excerpt">${esc(t.excerpt)}</div>
        </div>`).join('')
    : `<p class="empty-state">No repeated words, spacing faults or unrendered placeholders were detected. This is a mechanical scan, not a dictionary spell check.</p>`,
    { muted: e.textIssues.count === 0 }));

  // Bold / strong
  out.push(details('Bold and strong tags', e.bold.count, e.bold.count
    ? `<div class="chiplist">${e.bold.list.map((b) => `<span>${esc(truncate(b, 90))}</span>`).join('')}</div>`
    : '<p class="empty-state">No strong or bold tags on this page.</p>', { muted: e.bold.count === 0 }));

  // Media
  out.push(details('Media files', e.media.count, `
    <div class="chiplist">
      <span>${e.media.images} images</span><span>${e.media.withAlt} with alt</span>
      <span>${e.media.missingAlt} missing alt</span><span>${e.media.lazy} lazy-loaded</span>
      <span>${e.media.inlineSvg} inline SVG</span>
    </div>
    ${table(['Type', 'File', 'ALT text', { label: 'Size', align: 'right' }, 'Loading'], e.media.list.map((m) => `
      <tr>
        <td class="mono">${esc(m.tag)}</td>
        <td class="mono strong" title="${esc(m.src || '')}">${esc(fileName(m.src))}</td>
        <td>${m.alt === null ? '<span class="tag fail">no alt attribute</span>' : m.alt === '' ? '<span class="tag neutral">decorative (alt="")</span>' : esc(truncate(m.alt, 120))}</td>
        <td class="num">${m.width && m.height ? `${esc(m.width)}×${esc(m.height)}` : '<span class="muted">—</span>'}</td>
        <td class="mono">${m.loading ? esc(m.loading) : '<span class="muted">eager</span>'}</td>
      </tr>`))}
  `));

  // Meta tags
  out.push(details('Meta tags', e.metaTags.count, table(['Name', 'Content'], e.metaTags.list.map((m) => `
    <tr><td class="mono strong">${esc(m.name)}</td><td>${m.content ? esc(truncate(m.content, 300)) : '<span class="muted">(empty)</span>'}</td></tr>`))));

  // Internal links
  out.push(details('Out. links (int.)', e.internalLinks.count, table(['Anchor text', 'Target', 'Rel'], e.internalLinks.list.map((l) => `
    <tr>
      <td class="strong">${l.anchor ? esc(truncate(l.anchor, 120)) : '<span class="tag warn">no anchor text</span>'}</td>
      <td class="mono">${esc(shortUrl(l.href, origin))}</td>
      <td class="mono">${l.nofollow ? tag('nofollow', 'warn') : '<span class="muted">follow</span>'}</td>
    </tr>`))));

  // External links
  out.push(details('External links', e.externalLinks.count, table(['Anchor text', 'Target', 'Rel'], e.externalLinks.list.map((l) => `
    <tr>
      <td class="strong">${l.anchor ? esc(truncate(l.anchor, 120)) : '<span class="tag warn">no anchor text</span>'}</td>
      <td class="mono">${esc(shortUrl(l.href))}</td>
      <td class="mono">${l.nofollow ? tag('nofollow', 'neutral') : '<span class="muted">follow</span>'}${l.target === '_blank' && !/noopener/.test(l.rel || '') ? tag('unsafe _blank', 'warn') : ''}</td>
    </tr>`))));

  // HTTP headers
  out.push(details('HTTP response header', e.httpHeaders.protocol, `
    ${e.httpHeaders.redirectChain.length > 1 ? `<div class="chiplist">${e.httpHeaders.redirectChain.map((h) => `<span>${h.status} ${esc(shortUrl(h.url))}</span>`).join('')}</div>` : ''}
    ${table(['Header', 'Value'], e.httpHeaders.list.map((h) => `
      <tr><td class="mono strong">${esc(h.name)}</td><td class="mono">${esc(truncate(h.value, 300))}</td></tr>`))}
  `));

  // Structured data & previews
  const s = e.summary;
  out.push(details('Structured data & previews', s.structuredData.length || 'None', `
    <div class="chiplist">
      ${s.structuredData.map((t) => `<span>${esc(t)}</span>`).join('') || '<span>No JSON-LD types found</span>'}
      <span>${s.lists} lists</span><span>${s.tables} tables</span>
      <span>${s.fragments} in-page anchors</span><span>${s.mailtoTel} mail/tel links</span>
    </div>
    ${table(['Property', 'Value'], [
      ...Object.entries(s.openGraph).map(([k, v]) => `<tr><td class="mono strong">og:${esc(k)}</td><td>${v ? esc(truncate(v, 200)) : '<span class="tag warn">missing</span>'}</td></tr>`),
      ...Object.entries(s.twitter).map(([k, v]) => `<tr><td class="mono strong">twitter:${esc(k)}</td><td>${v ? esc(truncate(v, 200)) : '<span class="tag warn">missing</span>'}</td></tr>`),
    ])}
  `, { muted: s.structuredData.length === 0 }));

  el.elements.innerHTML = out.join('');
}

function renderKeywords(d) {
  const max = d.keywords.reduce((m, k) => Math.max(m, k.count), 1);

  el.keywords.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Most important keywords</h2>
        <span class="mono-note">${d.keywords.length} phrases · ${d.elements.keywords.basisWords} words analysed (${esc(d.elements.keywords.basisScope)})</span>
      </div>
      <div class="kw-legend"><p>
        Phrases of one to three words ranked by frequency and placement. A keyword that appears in the title,
        headings and body is one the page genuinely targets; a frequent phrase that appears nowhere in the title or
        headings usually means the page is about something other than what you intended.
      </p></div>
      ${table(
        ['Keyword', { label: 'Words', align: 'right' }, { label: 'Count', align: 'right' }, { label: 'Density', align: 'right' }, 'Found in'],
        d.keywords.map((k) => `
          <tr>
            <td class="strong">${esc(k.keyword)}<span class="kw-bar" style="width:${Math.round((k.count / max) * 100)}%"></span></td>
            <td class="num">${k.words}</td>
            <td class="num">${k.count}</td>
            <td class="num">${k.density.toFixed(2)}%</td>
            <td><div class="kw-flags">
              ${k.inTitle ? tag('Title', 'ok') : ''}
              ${k.inDescription ? tag('Description', 'ok') : ''}
              ${k.inHeadings ? tag(`Headings ×${k.inHeadings}`, 'ok') : ''}
              ${k.inUrl ? tag('URL', 'ok') : ''}
              ${!k.inTitle && !k.inDescription && !k.inHeadings && !k.inUrl ? tag('body only', 'warn') : ''}
            </div></td>
          </tr>`)
      )}
    </div>`;
}

// ---------------------------------------------------------------------------
// Site report
// ---------------------------------------------------------------------------

function renderSite(d) {
  el.siteScoreNum.textContent = `${d.score.overall}%`;
  el.siteScoreNum.style.color = scoreInk(d.score.overall);
  el.siteScoreVerdict.textContent = d.score.verdict;
  el.siteGauge.style.stroke = scoreColor(d.score.overall);
  el.siteGauge.style.strokeDasharray = `${(d.score.overall / 100) * GAUGE_CIRCUMFERENCE} ${GAUGE_CIRCUMFERENCE}`;

  el.siteStrong.textContent = d.score.distribution.strong;
  el.siteFair.textContent = d.score.distribution.fair;
  el.siteWeak.textContent = d.score.distribution.weak;

  el.siteMeters.innerHTML = d.categories.map((c) => `
    <div class="meter${c.measured ? '' : ' is-unmeasured'}">
      <div class="meter-label">${esc(c.label)}<em>${c.measured ? `avg of ${c.pages} pages` : 'not measured'}</em></div>
      <div class="meter-track"><i style="width:${c.measured ? c.score : 0}%;background:${scoreColor(c.measured ? c.score : null)}"></i></div>
      <div class="meter-score" style="color:${scoreInk(c.measured ? c.score : null)}">${c.measured ? `${c.score}%` : 'n/a'}</div>
    </div>`).join('');

  renderSiteFactsheet(d);
  renderVitalsInto($('#site-vitals-panel'), $('#site-vitals-note'), $('#site-vitals-body'), d.vitals);
  renderSiteTodos(d);
  renderSiteIssues(d);
  renderSitePages(d);

  el.siteCrawledAt.textContent = `Crawled ${new Date(d.startedAt).toLocaleString()}`;
  el.siteResults.hidden = false;
  el.backStrip.hidden = true;
  selectSiteTab('overview');
  el.siteResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderSiteFactsheet(d) {
  const rows = [];
  const add = (label, value, wide = false) =>
    rows.push(`<div${wide ? ' class="span-2"' : ''}><dt>${esc(label)}</dt><dd>${value}</dd></div>`);

  add('Site', `<a href="${esc(d.origin)}" target="_blank" rel="noopener noreferrer">${esc(d.origin)}</a>`, true);
  add('Pages audited', `${d.crawl.crawled}${d.crawl.failed ? ` <span class="tag fail">${d.crawl.failed} failed</span>` : ''}`);
  add('URLs discovered', String(d.crawl.discovered));
  add('Not visited', d.crawl.notVisited > 0
    ? `${d.crawl.notVisited} <span class="mono-note">raise the page limit to go deeper</span>`
    : '<span class="muted">none — the whole site was covered</span>');
  add('Crawl time', `${(d.durationMs / 1000).toFixed(1)} sec`);
  add('Score range', `${d.score.worst}% – ${d.score.best}%`);
  add('robots.txt', d.crawl.robotsFound ? tag('found', 'ok') : tag('missing', 'warn'));
  add('Sitemap', d.crawl.sitemapFound ? `${tag('found', 'ok')}<span class="mono-note">${d.crawl.sitemapUrls} URLs</span>` : tag('missing', 'warn'));

  el.siteFactsheet.innerHTML = rows.join('');
}

function renderSiteTodos(d) {
  if (!d.todos.length) {
    el.siteTodos.innerHTML = `<div class="panel"><p class="empty-state"><b>Nothing to fix.</b> Every measurable check passed on all ${d.crawl.crawled} pages.</p></div>`;
    return;
  }

  el.siteTodos.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Site to-do list</h2>
        <span class="mono-note">${d.todos.length} tasks across ${d.crawl.crawled} pages</span>
      </div>
      ${d.todos.map((t) => `
        <div class="todo-row">
          <div class="todo-action">
            <span class="site-todo-count">${t.pageCount} ${t.pageCount === 1 ? 'page' : 'pages'}</span>${esc(t.action)}
            <span class="because"><span class="where">${esc(t.category)} › ${esc(t.check)}</span></span>
          </div>
          <div><span class="imp imp-${t.importance}">${esc(t.importanceLabel)}</span></div>
        </div>`).join('')}
    </div>`;
}

function renderSiteIssues(d) {
  const i = d.issues;
  const origin = d.origin;
  const short = (u) => esc(shortUrl(u, origin));
  const out = [];

  const dupSection = (title, groups, note) => details(title, groups.length || 'None', groups.length
    ? groups.map((g) => `
        <div class="dup-group">
          <div class="dup-value"><span class="n">${g.count} pages</span>${esc(truncate(g.value, 160))}</div>
          <ul class="dup-urls">${g.urls.map((u) => `<li>${short(u)}</li>`).join('')}</ul>
        </div>`).join('')
    : `<p class="empty-state">${esc(note)}</p>`, { muted: groups.length === 0, open: groups.length > 0 });

  out.push(dupSection('Duplicate titles', i.duplicateTitles,
    'Every page has a distinct title. Duplicate titles make search engines pick one page and ignore the others.'));
  out.push(dupSection('Duplicate meta descriptions', i.duplicateDescriptions,
    'Every page has a distinct meta description.'));
  out.push(dupSection('Duplicate H1 headings', i.duplicateH1s,
    'Every page has a distinct H1.'));
  out.push(dupSection('Duplicate content', i.duplicateContent,
    'No two pages share the same body text.'));

  const urlList = (title, urls, note) => details(title, urls.length || 'None', urls.length
    ? `<ul class="blocklist">${urls.map((u) => `<li>${short(u)}</li>`).join('')}</ul>`
    : `<p class="empty-state">${esc(note)}</p>`, { muted: urls.length === 0 });

  out.push(urlList('Missing meta description', i.missingDescriptions, 'Every page has a meta description.'));
  out.push(urlList('Missing H1', i.missingH1s, 'Every page has an H1.'));
  out.push(urlList('Missing title', i.missingTitles, 'Every page has a title.'));
  out.push(urlList('Blocked from indexing', i.noindexPages, 'No crawled page carries a noindex directive.'));

  out.push(details('Thin pages', i.thinPages.length || 'None', i.thinPages.length
    ? table(['URL', { label: 'Words', align: 'right' }], i.thinPages.map((p) => `
        <tr><td class="mono">${short(p.url)}</td><td class="num">${p.wordCount}</td></tr>`))
    : '<p class="empty-state">No page is under 300 words.</p>', { muted: i.thinPages.length === 0 }));

  out.push(details('Broken pages', i.brokenPages.length || 'None', i.brokenPages.length
    ? table(['URL', 'Status', 'Linked from'], i.brokenPages.map((p) => `
        <tr><td class="mono">${short(p.url)}</td><td>${tag(p.status, 'fail')}</td>
        <td class="mono">${p.linkedFrom.map(short).join('<br>') || '<span class="muted">—</span>'}</td></tr>`))
    : '<p class="empty-state">Every crawled URL returned a successful status.</p>', { muted: i.brokenPages.length === 0 }));

  out.push(details('Pages reached via redirect', i.redirectingPages.length || 'None', i.redirectingPages.length
    ? table(['From', 'To', { label: 'Hops', align: 'right' }], i.redirectingPages.map((p) => `
        <tr><td class="mono">${short(p.from)}</td><td class="mono">${short(p.to)}</td><td class="num">${p.hops}</td></tr>`))
    : '<p class="empty-state">No crawled URL needed a redirect.</p>', { muted: i.redirectingPages.length === 0 }));

  out.push(details('Possible orphan pages', i.orphanCandidates.length || 'None', i.orphanCandidates.length
    ? `<p class="kw-legend"><p>These URLs are in the sitemap but nothing linked to them from the pages crawled. Deepen the crawl to confirm — a page linked only from an uncrawled page will appear here too.</p></p>
       <ul class="blocklist">${i.orphanCandidates.map((u) => `<li>${short(u)}</li>`).join('')}</ul>`
    : '<p class="empty-state">Every sitemap URL crawled was linked from somewhere.</p>', { muted: i.orphanCandidates.length === 0 }));

  out.push(details('Deep pages (4+ clicks)', i.deepPages.length || 'None', i.deepPages.length
    ? table(['URL', { label: 'Depth', align: 'right' }], i.deepPages.map((p) => `
        <tr><td class="mono">${short(p.url)}</td><td class="num">${p.depth}</td></tr>`))
    : '<p class="empty-state">No page is more than three clicks from the start URL.</p>', { muted: i.deepPages.length === 0 }));

  out.push(details('Slow pages', i.slowPages.length || 'None', i.slowPages.length
    ? table(['URL', { label: 'TTFB', align: 'right' }], i.slowPages.map((p) => `
        <tr><td class="mono">${short(p.url)}</td><td class="num">${(p.responseMs / 1000).toFixed(2)} s</td></tr>`))
    : '<p class="empty-state">Every page responded in under 0.8 seconds.</p>', { muted: i.slowPages.length === 0 }));

  if (i.unreachable.length) {
    out.push(details('Could not be audited', i.unreachable.length,
      table(['URL', 'Reason'], i.unreachable.map((f) => `
        <tr><td class="mono">${short(f.url)}</td><td>${esc(f.error)}</td></tr>`)), { open: true }));
  }

  el.siteIssues.innerHTML = out.join('');
}

function renderSitePages(d) {
  const rows = [...d.pages].sort((a, b) => a.score - b.score).map((p) => `
    <tr>
      <td>
        <button class="page-link" data-page-url="${esc(p.finalUrl)}">${esc(shortUrl(p.url, d.origin))}</button>
        <span class="page-title-cell">${p.title ? esc(truncate(p.title, 80)) : '<span class="tag fail">no title</span>'}</span>
      </td>
      <td class="num">${p.wordCount}</td>
      <td class="num">${typeof p.depth === 'number' ? p.depth : '<span class="muted">—</span>'}</td>
      <td class="num">${p.errors ? `<span style="color:var(--red-ink)">${p.errors}</span>` : '0'} / ${p.warnings}</td>
      <td>
        <div class="score-cell">
          <span class="bar"><i style="width:${p.score}%;background:${scoreColor(p.score)}"></i></span>
          <b style="color:${scoreInk(p.score)}">${p.score}%</b>
        </div>
      </td>
    </tr>`);

  el.sitePages.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Pages</h2>
        <span class="mono-note">worst first · select a URL for its full report</span>
      </div>
      ${table(['URL', { label: 'Words', align: 'right' }, { label: 'Depth', align: 'right' },
               { label: 'Err / Warn', align: 'right' }, { label: 'Score', align: 'right' }], rows)}
    </div>`;

  el.sitePages.querySelectorAll('[data-page-url]').forEach((button) => {
    button.addEventListener('click', () => runAudit(button.dataset.pageUrl, { keepSiteReport: true }));
  });
}

// ---------------------------------------------------------------------------
// Tabs, export, wiring
// ---------------------------------------------------------------------------

function selectSiteTab(name) {
  el.siteTabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.stab === name));
  el.siteResults.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.dataset.spanel === name));
}

el.siteTabs.addEventListener('click', (event) => {
  const button = event.target.closest('.tab');
  if (button) selectSiteTab(button.dataset.stab);
});

function setMode(next) {
  mode = next;
  el.modeSwitch.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === next));
  el.pagesField.hidden = next !== 'site';
  el.urlLabel.textContent = next === 'site' ? 'Site to crawl' : 'Page to check';
  el.run.textContent = next === 'site' ? 'Crawl site' : 'Check page';
  el.input.placeholder = next === 'site' ? 'https://example.com' : 'https://example.com/page';
}

el.modeSwitch.addEventListener('click', (event) => {
  const button = event.target.closest('.mode-btn');
  if (button) setMode(button.dataset.mode);
});

el.backToSite.addEventListener('click', () => {
  el.results.hidden = true;
  el.backStrip.hidden = true;
  el.siteResults.hidden = false;
  el.siteResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

el.siteExport.addEventListener('click', () => {
  if (!lastSiteReport) return;
  downloadJson(lastSiteReport, `site-audit-${new URL(lastSiteReport.origin).hostname}-${lastSiteReport.startedAt.slice(0, 10)}.json`);
});

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function selectTab(name) {
  el.tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === name));
}

el.tabs.addEventListener('click', (event) => {
  const button = event.target.closest('.tab');
  if (button) selectTab(button.dataset.tab);
});

el.export.addEventListener('click', () => {
  if (!lastReport) return;
  downloadJson(lastReport, `audit-${new URL(lastReport.page.url).hostname}-${lastReport.analyzedAt.slice(0, 10)}.json`);
});

const submit = () => (mode === 'site' ? runCrawl() : runAudit());
el.run.addEventListener('click', submit);
el.input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });

// ?url= prefills and auto-runs, which makes reports linkable; ?mode=site crawls.
const params = new URLSearchParams(location.search);
const preset = params.get('url');
if (params.get('mode') === 'site') setMode('site');
if (params.get('pages')) el.maxPages.value = params.get('pages');
if (preset) {
  el.input.value = preset;
  submit();
}
