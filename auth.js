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

// Token purposes. Every token carries one, and verifyToken() will only accept a token
// whose purpose matches what the caller asked for.
//
// Why this exists: before it, `aud` was signed into every token but never actually
// checked, which made the four services' tokens fully interchangeable — a 5-minute
// handoff token minted for globe-invest was accepted as an OutsideFramework admin
// session cookie, and handoff tokens travel in URL query strings (?auth=...) where they
// leak through Referer headers, browser history and downstream access logs. Purpose +
// audience are now both enforced, so a token can only be replayed as the exact thing it
// was minted to be, at the exact service it was minted for.
const TYP_SESSION = 'session'; // long-lived local login cookie for one service
const TYP_HANDOFF = 'handoff'; // short-lived cross-service handoff, travels in a URL
const TYP_STATE = 'state';     // OAuth state parameter, binds one consent-screen round trip

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

// Returns the decoded payload object on success, or null on any failure (malformed
// token, bad signature, expired, wrong audience, wrong purpose). Never throws.
//
// `expected` is REQUIRED to carry { typ } and — for anything that grants access — { aud }.
// Callers that pass neither get signature+expiry checking only, which is what the old
// behavior was; that path is kept solely so token-inspection utilities can decode a token
// without asserting what it is. Never use it to gate access.
function verifyToken(token, secret, expected = {}) {
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
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || Date.now() / 1000 > payload.exp) return null;

  // Purpose check. A token minted without a typ is a pre-fix token: reject it rather than
  // grandfathering it in, because "no typ" is exactly what a replayed old token looks like.
  // The only cost is that sessions issued before this deploy need one fresh login.
  if (expected.typ) {
    if (payload.typ !== expected.typ) return null;
  }

  // Audience check. Accepts a single origin or a list.
  if (expected.aud) {
    const allowed = Array.isArray(expected.aud) ? expected.aud : [expected.aud];
    if (typeof payload.aud !== 'string' || !allowed.includes(payload.aud)) return null;
  }

  return payload;
}

// ── Per-audience key derivation ──────────────────────────────────────────────────────
// Every token is signed with a key derived from the audience it is minted for:
//
//   service_key(aud) = HMAC-SHA256(AUTH_SIGNING_SECRET, "ofw-token-v2|" + aud)
//
// So a token minted for globe-invest cannot verify at article-db — not because someone
// remembered to compare `aud`, but because the signature is computed under a different
// key. That is the whole point: the audit found `aud` signed-but-unchecked in four places,
// and a rule that depends on every call site remembering a comparison is a rule that will
// break again. verifyFor() cannot even be called without naming the audience, because the
// audience is what produces the key.
//
// This is deliberately NOT a blast-radius fix: all four services still hold the same
// master secret, so any of them can derive any other's key. Splitting the master out so
// each service only holds its own derived key is a separate change requiring per-service
// Railway env vars.
const KEY_CONTEXT = 'ofw-token-v2';

function deriveKey(masterSecret, aud) {
  return crypto
    .createHmac('sha256', String(masterSecret))
    .update(KEY_CONTEXT + '|' + String(aud))
    .digest();
}

// Signs a payload under its own audience's key. Throws rather than silently producing a
// token nobody can verify — a missing aud/typ here is a programming error, not input.
function signFor(payload, masterSecret) {
  if (!payload || typeof payload.aud !== 'string' || !payload.aud) {
    throw new Error('signFor: payload.aud is required');
  }
  if (typeof payload.typ !== 'string' || !payload.typ) {
    throw new Error('signFor: payload.typ is required');
  }
  return signToken(payload, deriveKey(masterSecret, payload.aud));
}

// Verifies a token that was minted for `expected.aud` with purpose `expected.typ`. Both
// are mandatory. Returns the payload or null.
function verifyFor(token, masterSecret, expected) {
  if (!expected || typeof expected.aud !== 'string' || !expected.aud) return null;
  if (typeof expected.typ !== 'string' || !expected.typ) return null;
  return verifyToken(token, deriveKey(masterSecret, expected.aud), {
    aud: expected.aud,
    typ: expected.typ,
  });
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

// Constant-time compare for two short opaque strings (state nonces, CSRF values).
// Falls back to a plain length check first so unequal lengths don't throw.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
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

// How many reverse proxies sit in front of this service.
//
// X-Forwarded-For is APPENDED to by each proxy: a proxy writes the address it received
// the connection from onto the end. So with one trusted proxy the LAST entry is the only
// one written by infrastructure we control, and everything left of it is attacker text.
// Reading the FIRST entry — as this did before — let any client choose its own rate-limit
// bucket just by sending the header, which silently disabled every limiter built on it
// (verified: 340 requests with a rotating header, 0 blocked).
//
// Getting the direction right is only half of it. If NOTHING is in front of the process,
// there is no appended entry, so even the last element is still just whatever the client
// typed. That is why the header is ignored outright unless we are actually deployed behind
// a proxy — a directly-reachable server must use the socket address and nothing else.
const TRUSTED_PROXY_HOPS = (() => {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw !== undefined && raw !== '') return Math.max(0, Number(raw) || 0);
  const behindRailway =
    process.env.NODE_ENV === 'production' ||
    !!process.env.RAILWAY_PROJECT_ID ||
    !!process.env.RAILWAY_ENVIRONMENT_NAME;
  return behindRailway ? 1 : 0;
})();

function clientIp(req) {
  const socketIp = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (TRUSTED_PROXY_HOPS === 0) return socketIp;
  const raw = req.headers['x-forwarded-for'];
  if (!raw) return socketIp;
  const parts = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // A header with fewer entries than there are proxies in front of us cannot have been
  // produced by those proxies — treat it as forged and fall back to the socket.
  if (parts.length < TRUSTED_PROXY_HOPS) return socketIp;
  return parts[parts.length - TRUSTED_PROXY_HOPS] || socketIp;
}

module.exports = {
  ALLOWED_ORIGINS,
  DEV_ORIGINS,
  TYP_SESSION,
  TYP_HANDOFF,
  TYP_STATE,
  KEY_CONTEXT,
  b64url,
  b64urlDecode,
  signToken,
  verifyToken,
  deriveKey,
  signFor,
  verifyFor,
  parseCookies,
  cookieHeader,
  clearCookieHeader,
  randomToken,
  safeEqual,
  originOf,
  isAllowedReturnTo,
  makeRateLimiter,
  clientIp,
};
