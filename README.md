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
| `server.js` | Express server; `GET`/`POST /api/analyze` |
| `analyzer.js` | Orchestration and every check definition |
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
| `TRUST_PROXY_HOPS` | `1` | Proxy hops in front of the app; use `0` if none |
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
- **No field performance data.** TTFB and HTML weight are measured; LCP, INP and
  CLS come from real users — pair this with PageSpeed Insights / CrUX.
- **Text issues are mechanical, not a spell check.** The scan finds repeated
  words, spacing faults, duplicated punctuation and unrendered template
  placeholders — things provable without a dictionary. It will not catch a
  correctly spelled wrong word.
- **Duplicate content is only checked within the page.** Cross-page duplication
  needs a full-site crawl.
- **One page per run.** Site-wide issues (duplicate titles across pages, orphan
  pages, internal link graph) need a crawler.
- **Public hosts only.** Intranet sites and `localhost` are blocked by the SSRF
  guard. Set `ALLOW_PRIVATE_HOSTS=true` locally if you need to audit one, and
  never set it on a deployed instance.

## Possible next steps

1. Multi-page crawl with aggregated site scoring and duplicate-title detection.
2. PageSpeed Insights / CrUX integration for real Core Web Vitals.
3. Backlink API integration to activate the External factors category.
4. Stored audit history with score trends over time.
5. PDF export for client deliverables.
6. Playwright rendering for SPA support.
