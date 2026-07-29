'use strict';
// Shared HMAC-signed token + cookie + CSRF + rate-limit helpers for the
// cross-domain login system (OutsideFramework central auth + globe-invest).
// Zero npm dependencies — only Node's built-in `crypto`.
//
// Token format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload_b64, secret))
// Verification HMACs the *received* payload_b64 string directly (never re-serializes
// JSON), so this is byte-for-byte compatible with the Python port of this same file
// (structural_holes/auth.py, article_db/auth.py) without any cross-language JSON
// canonicalization concerns.
//
// IMPORTANT: keep this file identical across every repo that copies it
// (this repo's root, globe-invest/). AUTH_SIGNING_SECRET must also be identical
// (same Railway env var value) across all four deployed services.

const crypto = require('crypto');

const ALLOWED_ORIGINS = [
  'https://ofw.up.railway.app',
  'https://globe-invest.up.railway.app',
  'https://structural-holes-production.up.railway.app',
  'https://articlebase.up.railway.app',
];

// Only honored when NODE_ENV !== 'production' — lets return_to/redirect
// validation work during local development without weakening prod checks.
const DEV_ORIGINS = [
  'http://localhost:8125', // outside-framework
  'http://localhost:8124', // globe
  'http://localhost:8129', // structural-holes (local dev, python but listed for parity)
  'http://localhost:8127', // article-db (local dev)
];

function b64url(bufOrStr) {
  const buf = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(bufOrStr);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function signToken(payloadObj, secret) {
  const payloadB64 = b64url(JSON.stringify(payloadObj));
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  return payloadB64 + '.' + b64url(sig);
}

// Returns the decoded payload object on success, or null on any failure
// (malformed token, bad signature, expired). Never throws.
function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  let providedSig;
  try {
    providedSig = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  if (providedSig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(providedSig, expectedSig)) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || Date.now() / 1000 > payload.exp) return null;
  return payload;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  });
  return out;
}

function cookieHeader(name, value, opts = {}) {
  const { maxAgeSec, httpOnly = true, secure = true, sameSite = 'Lax', path = '/' } = opts;
  let out = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) out += '; HttpOnly';
  if (secure) out += '; Secure';
  if (typeof maxAgeSec === 'number') out += `; Max-Age=${maxAgeSec}`;
  return out;
}

function clearCookieHeader(name, opts = {}) {
  return cookieHeader(name, '', { ...opts, maxAgeSec: 0 });
}

function randomToken(bytes = 24) {
  return b64url(crypto.randomBytes(bytes));
}

function originOf(urlStr) {
  try {
    return new URL(urlStr).origin;
  } catch {
    return null;
  }
}

function isAllowedReturnTo(urlStr) {
  const origin = originOf(urlStr);
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (process.env.NODE_ENV !== 'production' && DEV_ORIGINS.includes(origin)) return true;
  return false;
}

// Simple in-memory fixed-window rate limiter. Resets on process restart —
// intentionally not a distributed limiter; this is a personal single-instance
// deployment and the goal is raising the cost of naive automated abuse, not
// building a full defense.
function makeRateLimiter({ windowMs = 10 * 60 * 1000, max = 20 } = {}) {
  const hits = new Map();
  return function check(key) {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 5000) {
      for (const [k, e] of hits) {
        if (now > e.resetAt) hits.delete(k);
      }
    }
    return entry.count <= max;
  };
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return xf.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress;
}

module.exports = {
  ALLOWED_ORIGINS,
  DEV_ORIGINS,
  b64url,
  b64urlDecode,
  signToken,
  verifyToken,
  parseCookies,
  cookieHeader,
  clearCookieHeader,
  randomToken,
  originOf,
  isAllowedReturnTo,
  makeRateLimiter,
  clientIp,
};
