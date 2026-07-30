/* app.js — renders the audit report returned by /api/analyze. */

const $ = (sel) => document.querySelector(sel);
const el = {
  input: $('#url'), run: $('#run'), error: $('#error'), loading: $('#loading'),
  loadingText: $('#loading-text'), results: $('#results'),
  gauge: $('#gauge-fill'), scoreNum: $('#score-num'), scoreVerdict: $('#score-verdict'),
  errors: $('#count-errors'), warnings: $('#count-warnings'), passed: $('#count-passed'),
  meters: $('#hero-meters'), factsheet: $('#factsheet'), analyzedAt: $('#analyzed-at'),
  todos: $('#todos'), todoPanel: $('#todo-panel'), checks: $('#checks'),
  elements: $('#elements'), keywords: $('#keywords'), tabs: $('#tabs'), export: $('#export'),
};

const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 68;
let lastReport = null;

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

async function runAudit() {
  const url = el.input.value.trim();
  el.error.hidden = true;
  if (!url) {
    el.error.textContent = 'Enter a URL to check.';
    el.error.hidden = false;
    return;
  }

  el.run.disabled = true;
  el.loading.hidden = false;
  el.results.hidden = true;

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
    render(data);
  } catch (err) {
    el.error.textContent = err.message;
    el.error.hidden = false;
  } finally {
    clearInterval(ticker);
    el.run.disabled = false;
    el.loading.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(d) {
  renderHero(d);
  renderFactsheet(d);
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
// Tabs, export, wiring
// ---------------------------------------------------------------------------

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
  const blob = new Blob([JSON.stringify(lastReport, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `audit-${new URL(lastReport.page.url).hostname}-${lastReport.analyzedAt.slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

el.run.addEventListener('click', runAudit);
el.input.addEventListener('keydown', (event) => { if (event.key === 'Enter') runAudit(); });

// Allow ?url= to prefill and auto-run, which makes reports linkable.
const preset = new URLSearchParams(location.search).get('url');
if (preset) {
  el.input.value = preset;
  runAudit();
}
