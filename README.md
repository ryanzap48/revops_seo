# RevOps SEO — Page Checker

A single-page SEO audit tool in the mould of Seobility: submit a URL and get an
on-page score, six weighted category scores, a priority-ordered to-do list, ~32
checks with point-level findings, a full element inventory, and a keyword profile.

The interface follows the revops.health identity — green `#76B043`, uppercase
wide-tracked display type, Work Sans / Source Sans, pill buttons — on a white,
minimal ground built for reading long reports. Eurostile is the site's real
display face; `public/styles.css` has a commented `@font-face` block to drop it
in if you hold the licence, and falls back to tracked Work Sans otherwise.

```bash
npm install
npm start
# http://localhost:3000
```

## The report

**Score summary** — an on-page score out of 100 with a verdict, error/warning/pass
counts, and a meter per category.

| Category | Weight | Checks |
|---|---|---|
| Meta data | 22% | Title, meta description, crawlability, canonical, language, hreflang, other meta tags, domain, page URL, charset, doctype, favicon |
| Page quality | 24% | Content (11 findings), frames, mobile optimization, strong/bold tags, image SEO, social media, additional markup, HTTPS |
| Page structure | 14% | H1 heading, heading hierarchy |
| Link structure | 14% | Internal links, external links |
| Server configuration | 18% | HTTP redirects, HTTP header, security headers, performance, protocol & transport, robots.txt & sitemap |
| Core Web Vitals | 16% | LCP, INP, CLS, FCP, TTFB and the pass/fail assessment — needs `CRUX_API_KEY` |
| External factors | excluded | Backlinks (not measured), entity signals |

**HTML page** — meta title, meta description, URL, status code, index/follow
status, detected vs declared language, TTFB, file size (decompressed and over the
wire), word count, protocol, TLS version, server, server IP, charset, canonical,
and the redirect chain.

**To-do list** — every failed or warned finding turned into a concrete action,
sorted by importance (Very important → Nice to have), each showing which check
produced it and why.

**Checks** — every category expanded: the check name, its points (`8/11`), its
importance, the subject it examined (the actual title text, canonical URL, H1…),
and one line per finding with a `→` fix for anything that is not passing.

**Elements** — heading outline, recognized text paragraphs, text issues, bold and
strong tags, media files (with alt text, dimensions, loading), meta tags,
internal links, external links, HTTP response headers, structured data and social
previews.

**Keyword check** — the top 25 one-to-three-word phrases by frequency and
placement, with density and flags for title / description / headings / URL. A
frequent phrase that appears in none of those is a signal the page is about
something other than what was intended.

`Export JSON` downloads the whole report. `?url=…&tab=…` makes a report linkable.

## Whole-site crawl

Switch the mode toggle to **Whole site** to crawl and audit up to 100 pages, then
score the site as a whole. This finds the class of problem a single-page audit
structurally cannot see.

Discovery uses two sources. A breadth-first walk from the start URL establishes
click depth and the internal link graph; the XML sitemap then fills the remaining
page budget, which is what makes orphans visible — a URL the sitemap advertises
that no crawled page links to. robots.txt is respected, and non-HTML URLs are
skipped.

**Site score** is the mean of the page scores, with each category averaged the
same way, plus a spread of how many pages are strong / fair / weak.

**Site to-do list** rolls page-level tasks up by check and counts the pages
affected. One page needing 300 more words is a task; fourteen pages missing a
canonical is a template bug, and the count is what tells them apart.

**Site issues** covers what only a crawl can find: duplicate titles, duplicate
meta descriptions, duplicate H1s, duplicate body content, missing metadata,
broken pages with the pages linking to them, pages reached only via redirect,
noindex pages, thin pages, possible orphans, pages more than three clicks deep,
and slow pages.

**Pages** lists every page worst-score-first; selecting one runs the full
single-page audit for it, with a link back to the site report.

Because a crawl outlives an HTTP request — proxies including Render's cut
connections around 100s — it runs as a job:

```
POST /api/crawl        {"url": "example.com", "maxPages": 25}  →  202 {"jobId": "..."}
GET  /api/crawl/:jobId                                          →  progress, then result
```

The same crawl runs headless, for callers that want the JSON and nothing else —
the weekly analytics PDF uses this:

```bash
node crawl-cli.js --url revops.health --mode geo --max-pages 100 --out geo.json
```

Progress goes to stderr; without `--out` the report is written to stdout.

Jobs are in-memory and expire after 15 minutes. Redirects are resolved before the
crawl starts, so a seed of `example.com` that 301s to `www.example.com` anchors
the crawl to the destination rather than auditing the home page twice and
reporting itself as a duplicate.

### Memory on capped hosts

Node assumes it may grow its heap to roughly 2 GB. Inside a 512 MB container it
never feels pressure, so it expands until the platform OOM-kills it — even though
the crawler's live set is small (heap returns to baseline after collection; only
the ~200 kB result is retained). Capping the heap makes V8 collect instead of
expand, at no cost in speed:

| 70-page crawl | Peak RSS | Time |
|---|---|---|
| default heap | 493 MB | 6.8s |
| `--max-old-space-size=192` | 198 MB | 7.2s |

`render.yaml` sets `NODE_OPTIONS=--max-old-space-size=384`. Measured with that
cap, a **full 100-page crawl peaks at 197 MB and finishes in 9.6s**. Raise the
cap alongside the instance size; leave headroom, since the figure is the heap
only, not total process memory.

## GEO — Generative Engine Optimization

The `SEO / GEO` switch in the masthead runs the same pipeline — same fetch, same
document model, same crawler, same scoring — against a different ruleset. GEO
asks whether an AI answer engine can fetch the page, extract a passage from it,
and have reason to cite it.

| Category | Weight | Checks |
|---|---|---|
| AI crawler access | 24% | Retrieval / user-triggered / training crawler access, availability, server-rendered content, llms.txt |
| Answer readiness | 26% | Opening answer, passage structure, extractable formatting, answer depth |
| Evidence & citations | 22% | Statistics, quotations, source citations, freshness |
| Entity & authority | 16% | Publisher entity, sameAs, authorship, verifiability |
| Machine readability | 12% | Structured data, semantic HTML, described media |

Two decisions worth knowing, because they are where most GEO advice goes wrong:

**Weighting follows the evidence.** The KDD 2024 paper
[*GEO: Generative Engine Optimization*](https://arxiv.org/abs/2311.09735) tested
nine content strategies over 10,000 queries and found that adding statistics,
quotations and citations raised citation rates by up to 40%, while keyword
density — the classic SEO lever — barely moved them. So evidence signals carry
the heavy weight and keyword density is not scored here at all.

**Training crawlers and retrieval crawlers are not the same thing.** Blocking
GPTBot or ClaudeBot opts out of model training and costs nothing in citations.
Blocking OAI-SearchBot, PerplexityBot or Claude-SearchBot removes the page from
the answers themselves. This tool reports a training-crawler block as neutral
information and only penalises retrieval blocks — conflating the two would push
publishers into a licensing decision the tool has no business making for them.
robots.txt is evaluated per user-agent, honouring the rule that a specific group
overrides `*`.

llms.txt is checked but weighted as *nice to have*: adoption sits near 9% of top
sites and no measured citation lift has been demonstrated, so scoring it heavily
would be inventing a signal.

Both modes support single-page and whole-site crawls, with the same page limits.

## Core Web Vitals

Every other check in this tool inspects the page source. Core Web Vitals cannot
be inspected — they are measured on real visitors' devices, and they are what
Google actually ranks on. So they are fetched from the **Chrome UX Report**:
LCP, INP and CLS against Google's published thresholds, plus FCP and TTFB, with
the full good / needs-improvement / poor split rather than only the 75th
percentile. The assessment passes only when LCP, INP and CLS are all good.

URL-level data is requested first and falls back to origin-level, which is the
normal outcome — most individual pages carry too little traffic for their own
record, and the report says which one you are looking at. A crawl fetches the
origin record once and reuses it.

**This needs `CRUX_API_KEY`.** Enable the *Chrome UX Report API* in Google Cloud,
create a key, and set it. There is no zero-config path: CrUX answers `403`
without a key, and PageSpeed Insights is not a substitute — its anonymous quota
is a shared global pool that is already exhausted in practice (`429`), and a PSI
call takes 10–30s against CrUX's ~300ms, which a 50-page crawl cannot absorb.

Without a key the category is shown, explains itself, and is **excluded from the
score** — it is never estimated. Because `finalize()` renormalises across the
categories it could measure, adding this category left every existing score
unchanged until a key is configured.

Two caveats worth stating plainly:

- CrUX only reports addresses above a traffic threshold. "No data" is a statement
  about traffic, not about speed — a fast low-traffic page returns nothing.
- Field data is a 28-day trailing window, so a fix made today will not move these
  numbers for weeks.

## Scoring

Every finding is worth exactly one point, so `8/11` always maps to three
identifiable lines of text. Findings are binary — a warning scores zero, same as
an error — but the *check* is labelled by its worst finding.

A category percentage is not a raw point average: points are weighted by the
importance of the check that produced them (Very important ×3, Important ×2, Low
×1, Nice to have ×0.5), so a broken title outweighs a missing favicon. The
on-page score is the category scores combined by the weights above.

Categories that cannot be measured are reported with their findings but excluded
from the score and reweighted out, rather than being guessed at.

## Architecture

| File | Role |
|---|---|
| `server.js` | Express server; `/api/analyze` and the `/api/crawl` job routes |
| `analyzer.js` | Orchestration and every check definition; `buildSiteContext()` for crawls |
| `lib/crawler.js` | Site crawl, cross-page analysis and aggregate scoring |
| `lib/jobs.js` | In-memory job store for crawls, with TTL and stale-job reaping |
| `lib/robots.js` | robots.txt rule matching, shared by the check and the crawler |
| `lib/vitals.js` | Chrome UX Report client, thresholds and rating logic |
| `lib/geo.js` | AI crawler registry, evidence detection and the GEO ruleset |
| `lib/http.js` | HTTP client on `node:http(s)` — raw Content-Encoding, transfer size, redirect chain, per-request timings, ALPN/TLS probe, robots.txt and sitemap fetchers |
| `lib/guard.js` | SSRF guard: rejects non-public targets and pins sockets to validated addresses |
| `lib/ratelimit.js` | Per-IP request quota plus per-client and global concurrency caps |
| `lib/extract.js` | HTML → document model (headings, paragraphs, media, links, meta, structured data, mixed content) |
| `lib/checks.js` | Category/check/finding scoring skeleton |
| `lib/text.js` | Tokenising, stop words, sentence splitting, language detection, text-issue scan, keyword extraction |
| `lib/pixels.js` | Arial advance widths, for measuring title/description truncation in pixels rather than characters |
| `public/` | Front end (no build step, no framework) |

`fetch` is deliberately not used for the page request: it hides the original
`Content-Encoding`, the pre-decompression transfer size, the redirect chain and
the negotiated protocol — all of which the server checks report on.

## Security

A service that fetches any URL a caller supplies is an SSRF vector: left open, a
request for `http://169.254.169.254/` makes the server read its own cloud
metadata (which can hand out IAM credentials), and private addresses turn it into
an internal network scanner.

`lib/guard.js` runs inside `requestOnce`, the single function every outbound
request passes through — the page, robots.txt, the sitemap, the favicon probe,
the www/non-www check, and **each hop of a redirect chain**. It:

- allows only `http:` and `https:`, and only ports 80/443 below 1024;
- resolves the hostname and refuses if **any** returned address is loopback,
  link-local, private, CGNAT, multicast or reserved — in IPv4 or IPv6, including
  the IPv4 embedded in v4-mapped, NAT64 and 6to4 addresses;
- **pins the socket to an address it validated**, via the `lookup` option. Checking
  a hostname and then letting the socket resolve it again leaves a DNS-rebinding
  window where the attacker's resolver answers publicly for the check and
  privately for the connection.

Decimal (`http://2130706433/`), hex (`http://0x7f.0.0.1/`), short-form
(`http://127.1/`) and resolver-based (`http://127.0.0.1.nip.io/`) encodings are all
covered, because the check runs on resolved addresses rather than on URL text.

Rate limiting (`lib/ratelimit.js`) applies to both `/api/analyze` routes: a per-IP
quota, a per-client in-flight cap so one caller cannot queue slow audits, and a
global in-flight cap so the process cannot exhaust its sockets. Rejected requests
count against the quota, which also throttles anyone scanning for internal hosts.
Counters are in-memory — per instance, reset on deploy — which is the right trade
for one small service. Put Redis behind it only if you scale to several instances.

`app.set('trust proxy', 1)` is set because Render, Railway and Fly each add one
proxy hop; without it every caller would share a single rate-limit bucket. It
trusts exactly one hop, so a client cannot forge its own `X-Forwarded-For`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Set automatically by most hosts |
| `RATE_LIMIT_MAX` | `20` | Audits per IP per window |
| `RATE_LIMIT_WINDOW_MS` | `300000` | Window length (5 min) |
| `MAX_CONCURRENT_PER_CLIENT` | `2` | Simultaneous audits per IP |
| `MAX_CONCURRENT_GLOBAL` | `8` | Simultaneous audits process-wide |
| `CRAWL_RATE_LIMIT_MAX` | `3` | Crawls per IP per crawl window |
| `CRAWL_RATE_LIMIT_WINDOW_MS` | `900000` | Crawl window length (15 min) |
| `MAX_CRAWL_PAGES` | `100` | Hard ceiling on pages per crawl |
| `NODE_OPTIONS` | unset | Set `--max-old-space-size=384` on memory-capped hosts (see below) |
| `MAX_CONCURRENT_CRAWLS` | `2` | Crawls running process-wide (1 per IP) |
| `TRUST_PROXY_HOPS` | `1` | Proxy hops in front of the app; use `0` if none |
| `CRUX_API_KEY` | unset | Chrome UX Report API key; enables the Core Web Vitals category (`PAGESPEED_API_KEY` is also accepted) |
| `CRUX_FORM_FACTOR` | `PHONE` | `PHONE`, `DESKTOP` or `TABLET` |
| `CRUX_ENDPOINT` | Google's | Override the CrUX base URL (proxy or test double) |
| `ALLOW_PRIVATE_HOSTS` | unset | `true` disables the SSRF guard so you can audit `localhost`. **Local development only** — the server logs a warning at boot when it is on |

`GET /health` returns `{ ok, trackedClients, globalActive }` and is not rate
limited, so it doubles as an uptime-monitor and keep-warm target.

## Limitations, stated plainly

- **No JavaScript execution.** The audit reads server-rendered HTML. A
  client-rendered SPA will under-report its content. Add a Playwright render step
  before `extract()` if you need that.
- **No backlink data.** Referring domains, backlink counts and referring IPs
  cannot be derived from a page's source. That category is shown but excluded from
  the score instead of being estimated. Wire in Ahrefs/Majestic/Semrush or Search
  Console to score it.
- **No lab performance data.** Field Core Web Vitals are covered via CrUX, but
  Lighthouse's lab diagnostics — render-blocking resources, unused CSS, image
  sizing opportunities — are not. That is the PageSpeed Insights half, and it is
  a separate feature: a PSI call takes 10–30s per URL.
- **Text issues are mechanical, not a spell check.** The scan finds repeated
  words, spacing faults, duplicated punctuation and unrendered template
  placeholders — things provable without a dictionary. It will not catch a
  correctly spelled wrong word.
- **Duplicate content is only checked within the page.** Cross-page duplication
  needs a full-site crawl.
- **Crawls are bounded.** Up to 100 pages, four levels deep, on a five-minute
  budget. Larger sites are sampled, not exhaustively covered, so "possible
  orphans" and duplicate groups describe the pages crawled — not the whole site.
  A crawl that runs out of budget reports `stoppedEarly` rather than implying it
  saw everything.
- **Crawl state is in memory.** Jobs expire after 15 minutes and are lost on
  deploy; there is no audit history.
- **GEO measures readiness, not outcomes.** It checks whether a page is fetchable,
  extractable and worth citing. It cannot tell you whether ChatGPT or Perplexity
  *actually* cites you — that needs prompt-level monitoring against those engines,
  which is a different product. Treat the score as a diagnostic, not a rank.
- **Evidence detection is pattern-based.** Statistics are matched by shape
  (percentages, currency, scaled counts) across paragraphs, headings, list items
  and table cells; quotations by markup and quote characters. A quote presented
  without quotation marks or `<blockquote>` will not be counted.
- **Public hosts only.** Intranet sites and `localhost` are blocked by the SSRF
  guard. Set `ALLOW_PRIVATE_HOSTS=true` locally if you need to audit one, and
  never set it on a deployed instance.

## Possible next steps

1. PageSpeed Insights lab diagnostics (Lighthouse opportunities) as an opt-in
   deep-dive on a single URL, given the 10–30s per-call cost.
2. Backlink API integration to activate the External factors category.
3. Stored audit history with score trends over time (needs a database).
4. PDF export for client deliverables.
5. Playwright rendering for SPA support.
6. Broken-link checking for internal targets beyond the crawl budget.
