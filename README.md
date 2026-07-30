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
| `lib/extract.js` | HTML → document model (headings, paragraphs, media, links, meta, structured data, mixed content) |
| `lib/checks.js` | Category/check/finding scoring skeleton |
| `lib/text.js` | Tokenising, stop words, sentence splitting, language detection, text-issue scan, keyword extraction |
| `lib/pixels.js` | Arial advance widths, for measuring title/description truncation in pixels rather than characters |
| `public/` | Front end (no build step, no framework) |

`fetch` is deliberately not used for the page request: it hides the original
`Content-Encoding`, the pre-decompression transfer size, the redirect chain and
the negotiated protocol — all of which the server checks report on.

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

## Possible next steps

1. Multi-page crawl with aggregated site scoring and duplicate-title detection.
2. PageSpeed Insights / CrUX integration for real Core Web Vitals.
3. Backlink API integration to activate the External factors category.
4. Stored audit history with score trends over time.
5. PDF export for client deliverables.
6. Playwright rendering for SPA support.
