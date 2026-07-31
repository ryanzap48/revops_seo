// lib/http.js
// Low-level HTTP client built on node:http/https rather than fetch, because the
// audit needs things fetch hides: the raw Content-Encoding, transfer size before
// decompression, the full redirect chain, per-request timings, and the ALPN
// protocol the server negotiates (for HTTP/2 detection).

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { assertPublicUrl, pinnedLookup } from './guard.js';

const UA = 'Mozilla/5.0 (compatible; RevOpsSeoBot/2.0; +https://revops.health/bot)';
const MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Accept-Language': 'en-US,en;q=0.9',
  'Connection': 'close',
};

function decompress(buf, encoding = '') {
  const enc = String(encoding).toLowerCase();
  if (!enc || !buf.length) return buf;
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) {
      try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); }
    }
  } catch {
    // Corrupt or mislabelled encoding — fall through and return the raw bytes.
  }
  return buf;
}

// A single request with no redirect following.
//
// Every outbound request in the app funnels through here, so the SSRF check
// lives here too — including each hop of a redirect chain, since fetchPage
// re-enters this function per hop.
export async function requestOnce(url, opts = {}) {
  const { method = 'GET', headers = {}, timeout = 20000, maxBytes = MAX_BYTES, body = null } = opts;
  const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));

  let target;
  try {
    target = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Throws BlockedUrlError for anything that is not a public HTTP(S) endpoint.
  const { addresses } = await assertPublicUrl(target);

  return new Promise((resolve, reject) => {
    const mod = target.protocol === 'https:' ? https : http;
    const start = process.hrtime.bigint();
    let headersAt = null;

    const req = mod.request(
      target,
      {
        method,
        headers: {
          ...DEFAULT_HEADERS,
          ...(payload ? { 'Content-Length': String(payload.length) } : {}),
          ...headers,
        },
        timeout,
        rejectUnauthorized: false,
        // Connect only to an address the guard already cleared.
        ...(addresses.length ? { lookup: pinnedLookup(addresses) } : {}),
      },
      (res) => {
        headersAt = process.hrtime.bigint();
        const chunks = [];
        let transferred = 0;

        res.on('data', (chunk) => {
          transferred += chunk.length;
          if (transferred <= maxBytes) chunks.push(chunk);
          else res.destroy();
        });

        res.on('end', () => finish(res, chunks, transferred, false));
        res.on('close', () => finish(res, chunks, transferred, true));
        res.on('error', reject);

        let done = false;
        function finish(r, parts, bytes, truncated) {
          if (done) return;
          done = true;
          const endAt = process.hrtime.bigint();
          const raw = Buffer.concat(parts);
          resolve({
            url: target.href,
            method,
            status: r.statusCode,
            statusMessage: r.statusMessage,
            httpVersion: r.httpVersion,
            headers: r.headers,
            rawHeaders: r.rawHeaders,
            location: r.headers.location || null,
            contentEncoding: r.headers['content-encoding'] || null,
            transferBytes: bytes,
            body: decompress(raw, r.headers['content-encoding']),
            truncated,
            ttfbMs: Number(headersAt - start) / 1e6,
            totalMs: Number(endAt - start) / 1e6,
          });
        }
      }
    );

    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeout} ms`)));
    req.on('error', (err) => reject(err));
    req.end(payload ?? undefined);
  });
}

// GET with manual redirect following so the whole chain is observable.
export async function fetchPage(startUrl, { maxRedirects = 6, ...opts } = {}) {
  const chain = [];
  let current = startUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await requestOnce(current, opts);
    const isRedirect = res.status >= 300 && res.status < 400 && res.location;

    chain.push({
      url: res.url,
      status: res.status,
      location: isRedirect ? new URL(res.location, res.url).href : null,
    });

    if (!isRedirect) {
      return { ...res, redirectChain: chain, redirected: chain.length > 1, requestedUrl: startUrl };
    }
    current = new URL(res.location, res.url).href;
  }

  throw new Error(`Too many redirects (more than ${maxRedirects}).`);
}

// Cheap existence probe: HEAD, falling back to GET for servers that reject HEAD.
export async function probe(url, timeout = 8000) {
  try {
    const head = await requestOnce(url, { method: 'HEAD', timeout, maxBytes: 1024 });
    if (head.status === 405 || head.status === 501) {
      const get = await requestOnce(url, { timeout, maxBytes: 4096 });
      return { ok: get.status >= 200 && get.status < 400, status: get.status, headers: get.headers };
    }
    return { ok: head.status >= 200 && head.status < 400, status: head.status, headers: head.headers };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

// Which HTTP version does the origin actually offer? node:https speaks 1.1 only,
// so ask the TLS layer what it would negotiate.
export async function negotiatedProtocol(hostname, port = 443, timeout = 6000) {
  const unknown = { alpn: null, protocol: null, tlsVersion: null };

  // This opens a raw socket, so it needs the same guard as an HTTP request.
  let addresses = [];
  try {
    ({ addresses } = await assertPublicUrl(`https://${hostname}:${port}`));
  } catch {
    return unknown;
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };

    const socket = tls.connect(
      {
        host: hostname,
        port,
        servername: hostname,
        ALPNProtocols: ['h2', 'http/1.1'],
        rejectUnauthorized: false,
        timeout,
        ...(addresses.length ? { lookup: pinnedLookup(addresses) } : {}),
      },
      () => {
        const alpn = socket.alpnProtocol;
        const cert = socket.getPeerCertificate?.() || {};
        done({
          alpn: alpn || null,
          protocol: alpn === 'h2' ? 'HTTP/2' : alpn === 'http/1.1' ? 'HTTP/1.1' : null,
          tlsVersion: socket.getProtocol?.() || null,
          certValidTo: cert.valid_to || null,
          certIssuer: cert.issuer?.O || null,
        });
        socket.end();
      }
    );

    socket.on('error', () => done(unknown));
    socket.on('timeout', () => { socket.destroy(); done(unknown); });
  });
}

export async function resolveHost(hostname) {
  try {
    const [v4] = await dns.resolve4(hostname).catch(() => [null]);
    return { ip: v4 || null };
  } catch {
    return { ip: null };
  }
}

/** The proposed llms.txt convention — a plain-text pointer file for LLMs. */
export async function fetchLlmsTxt(origin) {
  try {
    const res = await requestOnce(`${origin}/llms.txt`, { timeout: 8000, maxBytes: 256 * 1024 });
    if (res.status !== 200) return { found: false, status: res.status };
    const text = res.body.toString('utf8');
    // Some servers answer every unknown path with the HTML app shell.
    if (/^\s*<(!doctype|html)/i.test(text)) return { found: false, status: res.status, htmlInstead: true };
    return {
      found: true,
      status: res.status,
      bytes: Buffer.byteLength(text, 'utf8'),
      links: (text.match(/\]\(/g) || []).length,
      text: text.slice(0, 4000),
    };
  } catch {
    return { found: false, status: 0 };
  }
}

export async function fetchRobots(origin) {
  try {
    const res = await requestOnce(`${origin}/robots.txt`, { timeout: 8000, maxBytes: 512 * 1024 });
    if (res.status !== 200) return { found: false, status: res.status };
    const text = res.body.toString('utf8');
    // A robots.txt that is actually an HTML error page does not count.
    if (/^\s*<(!doctype|html)/i.test(text)) return { found: false, status: res.status, htmlInstead: true };
    const sitemaps = [...text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
    return {
      found: true,
      status: res.status,
      text,
      sitemaps,
      hasSitemap: sitemaps.length > 0,
      blocksAll: /user-agent:\s*\*[\s\S]*?disallow:\s*\/\s*$/im.test(text),
    };
  } catch (err) {
    return { found: false, status: 0, error: err.message };
  }
}

/**
 * Fetch an XML sitemap and return the URLs it lists. Sitemap indexes are
 * followed one level down, since that is where most sites keep the real list.
 */
export async function fetchSitemap(url, { maxUrls = 500, maxChildren = 5 } = {}) {
  try {
    const res = await requestOnce(url, { timeout: 10000, maxBytes: 4 * 1024 * 1024 });
    if (res.status !== 200) return { found: false, status: res.status, urls: [], urlCount: 0 };

    const text = res.body.toString('utf8');
    const locs = [...text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeXml(m[1]));
    const isIndex = /<sitemapindex/i.test(text);

    if (!isIndex) {
      return { found: true, status: res.status, isIndex: false, urlCount: locs.length, urls: locs.slice(0, maxUrls) };
    }

    // Sitemap index: pull URLs from the first few child sitemaps.
    const collected = [];
    for (const child of locs.slice(0, maxChildren)) {
      if (collected.length >= maxUrls) break;
      try {
        const sub = await requestOnce(child, { timeout: 10000, maxBytes: 4 * 1024 * 1024 });
        if (sub.status !== 200) continue;
        const subText = sub.body.toString('utf8');
        for (const m of subText.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
          collected.push(decodeXml(m[1]));
          if (collected.length >= maxUrls) break;
        }
      } catch { /* a broken child sitemap should not fail the whole read */ }
    }

    return {
      found: true, status: res.status, isIndex: true,
      childCount: locs.length, urlCount: collected.length, urls: collected,
    };
  } catch {
    return { found: false, status: 0, urls: [], urlCount: 0 };
  }
}

function decodeXml(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}
