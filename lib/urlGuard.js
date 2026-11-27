'use strict';
/**
 * Shared SSRF protection for user-supplied and scraped URLs.
 *
 * Validates protocol (http/https), blocks localhost/metadata/private IPv4 & IPv6
 * ranges both syntactically and after DNS resolution, and validates every
 * HTTP redirect hop instead of blindly using `redirect: 'follow'`.
 */

const dns = require('dns').promises;
const net = require('net');
const NATIVE_FETCH = global.fetch;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isPrivateIp(ip) {
  const clean = String(ip || '').trim().replace(/^\[|\]$/g, '');
  if (net.isIPv4(clean)) {
    const [a, b] = clean.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (net.isIPv6(clean)) {
    const v = clean.toLowerCase().split('%')[0];
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/i.test(v)) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata.google.internal' ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    return true;
  }
  if (net.isIP(host)) return isPrivateIp(host);
  return false;
}

/**
 * Synchronous syntactic check (protocol + literal private IP / localhost).
 * Use `assertPublicUrl` when async DNS validation is possible.
 */
function assertPublicHttpUrlSync(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http(s) URLs are allowed');
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error('Private/loopback hosts are not allowed');
  }
  return parsed;
}

/**
 * Full SSRF check including DNS resolution of the hostname.
 */
async function assertPublicUrl(rawUrl, { resolveDns = true } = {}) {
  const parsed = assertPublicHttpUrlSync(rawUrl);
  if (!resolveDns) return parsed;

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Private/loopback hosts are not allowed');
    return parsed;
  }

  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve host: ${host}`);
  }
  if (!addrs || !addrs.length || addrs.some(a => isPrivateIp(a.address))) {
    throw new Error('Private/loopback hosts are not allowed');
  }
  return parsed;
}

/**
 * Fetch wrapper that validates the initial URL and every redirect target
 * against private/loopback networks.
 */
async function safeFetch(rawUrl, options = {}, { fetchImpl = global.fetch, maxRedirects = 5, resolveDns = true } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  let currentUrl = String(rawUrl);
  let method = String(options.method || 'GET').toUpperCase();

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertPublicUrl(currentUrl, { resolveDns });
    const res = await fetchImpl(currentUrl, {
      ...options,
      method,
      redirect: 'manual',
    });

    if (!REDIRECT_STATUSES.has(res.status)) return res;

    const location = res.headers?.get?.('location');
    try { await res.body?.cancel?.(); } catch { /* ignore */ }
    if (!location) return res;

    currentUrl = new URL(location, currentUrl).toString();
    if (res.status === 303 && method !== 'GET' && method !== 'HEAD') {
      method = 'GET';
    }
  }
  throw new Error('Too many redirects');
}

module.exports = {
  NATIVE_FETCH,
  isPrivateIp,
  isBlockedHostname,
  assertPublicHttpUrlSync,
  assertPublicUrl,
  safeFetch,
};
