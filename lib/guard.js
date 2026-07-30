// lib/guard.js
// The auditor fetches whatever URL a caller hands it, which makes it an SSRF
// vector the moment it is reachable from the internet: without this, a request
// for http://169.254.169.254/ makes the server probe its own cloud metadata
// endpoint, and a request for a private RFC1918 address turns it into an
// internal network scanner.
//
// Two defences, both required:
//
//   1. Resolve the hostname and reject the request if ANY returned address is
//      not a public internet address.
//   2. Pin the socket to an address that was actually validated. Validating a
//      hostname and then letting the socket resolve it again is a DNS-rebinding
//      hole — the attacker's resolver can answer with a public address for the
//      check and a private one microseconds later for the connection.
//
// Set ALLOW_PRIVATE_HOSTS=true to disable this for local development, where
// auditing http://localhost:3000 is the point.

import dns from 'node:dns/promises';
import net from 'node:net';

const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_HOSTS === 'true';

// Privileged ports other than these are never HTTP and only exist here as a way
// to reach something that was not meant to be reached.
const ALLOWED_PRIVILEGED_PORTS = new Set([80, 443]);

export class BlockedUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedUrlError';
    this.blocked = true;
  }
}

// ---- IPv4 -----------------------------------------------------------------

function ipv4Reason(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 'not a valid IPv4 address';

  const [a, b] = p;
  if (a === 0) return 'in the unspecified 0.0.0.0/8 range';
  if (a === 10) return 'a private 10.0.0.0/8 address';
  if (a === 127) return 'a loopback address';
  if (a === 169 && b === 254) return 'a link-local address (this is the cloud metadata range)';
  if (a === 172 && b >= 16 && b <= 31) return 'a private 172.16.0.0/12 address';
  if (a === 192 && b === 168) return 'a private 192.168.0.0/16 address';
  if (a === 100 && b >= 64 && b <= 127) return 'a carrier-grade NAT address';
  if (a === 192 && b === 0 && p[2] === 0) return 'in the reserved 192.0.0.0/24 range';
  if (a === 198 && (b === 18 || b === 19)) return 'in the benchmarking 198.18.0.0/15 range';
  if (a === 192 && b === 0 && p[2] === 2) return 'a documentation-only address';
  if (a === 198 && b === 51 && p[2] === 100) return 'a documentation-only address';
  if (a === 203 && b === 0 && p[2] === 113) return 'a documentation-only address';
  if (a >= 224 && a <= 239) return 'a multicast address';
  if (a >= 240) return 'in the reserved 240.0.0.0/4 range';
  return null;
}

// ---- IPv6 -----------------------------------------------------------------

/** Expand any valid IPv6 text form (including ::ffff:1.2.3.4) to 16 bytes. */
function expandIpv6(input) {
  let text = input;
  const bytes = new Uint8Array(16);

  // A trailing dotted quad occupies the final four bytes.
  let embedded = null;
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const quad = dotted[1].split('.').map(Number);
    if (quad.some((n) => n > 255)) return null;
    embedded = quad;
    text = text.slice(0, dotted.index).replace(/:$/, '') + ':0:0';
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (part) =>
    part === '' ? [] : part.split(':').map((g) => {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return NaN;
      return parseInt(g, 16);
    });

  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;
  if (head.length + tail.length > 8) return null;
  if (halves.length === 1 && head.length !== 8) return null;

  const groups = [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i] >> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  if (embedded) bytes.set(embedded, 12);
  return bytes;
}

function ipv6Reason(ip) {
  const b = expandIpv6(ip);
  if (!b) return 'not a valid IPv6 address';

  const zeros = (from, to) => b.slice(from, to).every((x) => x === 0);
  const embeddedV4 = () => `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;

  if (b.every((x) => x === 0)) return 'the unspecified address';
  if (zeros(0, 15) && b[15] === 1) return 'a loopback address';
  if (b[0] === 0xff) return 'a multicast address';
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'a link-local address';
  if ((b[0] & 0xfe) === 0xfc) return 'a unique-local address';
  if (zeros(0, 8) && b[8] === 0xff && b[9] === 0xff) return 'in the discard-only 100::/64 range';

  // Tunnelled and translated forms carry an IPv4 address inside them, so the
  // embedded address has to face the same test.
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) {
    const reason = ipv4Reason(embeddedV4());
    return reason ? `an IPv4-mapped address for ${embeddedV4()}, which is ${reason}` : null;
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) {
    const reason = ipv4Reason(embeddedV4());
    return reason ? `a NAT64 address for ${embeddedV4()}, which is ${reason}` : null;
  }
  if (b[0] === 0x20 && b[1] === 0x02) {
    const relay = `${b[2]}.${b[3]}.${b[4]}.${b[5]}`;
    const reason = ipv4Reason(relay);
    return reason ? `a 6to4 address for ${relay}, which is ${reason}` : null;
  }
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return 'a Teredo tunnel address';

  return null;
}

/** Why this address may not be contacted, or null when it is a public address. */
export function addressReason(ip) {
  const bare = String(ip).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (net.isIPv4(bare)) return ipv4Reason(bare);
  if (net.isIPv6(bare)) return ipv6Reason(bare);
  return 'not a recognisable IP address';
}

export const isPublicAddress = (ip) => addressReason(ip) === null;

// ---- URL validation -------------------------------------------------------

/**
 * Verify a URL may be fetched, and return the validated addresses to connect to.
 * @throws {BlockedUrlError}
 */
export async function assertPublicUrl(input) {
  const url = input instanceof URL ? input : new URL(String(input));

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`Only http:// and https:// URLs can be audited (got ${url.protocol}).`);
  }

  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (port < 1024 && !ALLOWED_PRIVILEGED_PORTS.has(port)) {
    throw new BlockedUrlError(`Port ${port} is not an HTTP port and cannot be audited.`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (ALLOW_PRIVATE) return { url, addresses: [], hostname };

  // An IP literal needs no resolution — check it as given.
  if (net.isIP(hostname)) {
    const reason = addressReason(hostname);
    if (reason) throw new BlockedUrlError(`${hostname} is ${reason}. Only public internet hosts can be audited.`);
    return { url, addresses: [{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }], hostname };
  }

  let resolved;
  try {
    resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new BlockedUrlError(`${hostname} could not be resolved (${err.code || err.message}).`);
  }
  if (!resolved.length) throw new BlockedUrlError(`${hostname} did not resolve to any address.`);

  // One bad record is enough to refuse: a host that answers with both a public
  // and a private address is either misconfigured or attacking you.
  for (const { address } of resolved) {
    const reason = addressReason(address);
    if (reason) {
      throw new BlockedUrlError(`${hostname} resolves to ${address}, which is ${reason}. Only public internet hosts can be audited.`);
    }
  }

  return { url, addresses: resolved, hostname };
}

/**
 * A `lookup` implementation for http.request/tls.connect that hands back only
 * addresses this module already validated, closing the rebinding window between
 * the check and the connection.
 */
export function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    const family = options?.family ?? 0;
    const usable = family === 0 ? addresses : addresses.filter((a) => a.family === family);
    const chosen = usable.length ? usable : addresses;

    if (!chosen.length) {
      const err = new Error(`No validated address available for ${hostname}`);
      err.code = 'ENOTFOUND';
      return callback(err);
    }
    if (options?.all) return callback(null, chosen.map((a) => ({ address: a.address, family: a.family })));
    return callback(null, chosen[0].address, chosen[0].family);
  };
}

export const privateHostsAllowed = ALLOW_PRIVATE;
