const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');
const powerlog = require('./powerlog');
const fuelprice = require('./fuelprice');

const PORT = process.env.PORT || 8080;
const DATA_DIR = '/data';
// The Dockerfile copies server.js to / and app to /app, so this resolves to the
// exact same '/app' in the container while also working from a local checkout.
const APP_DIR = path.join(__dirname, 'app');

// ── Auth (cross-domain login system — see auth.js for the shared token format) ──
// OutsideFramework is the only service that talks to Google; this service just verifies
// tokens it mints and keeps its own short-lived local session once verified once.
const CENTRAL_AUTH_ORIGIN = process.env.CENTRAL_AUTH_ORIGIN || 'https://ofw.up.railway.app';
const AUTH_SECRET = process.env.AUTH_SIGNING_SECRET || '';
// Comma-separated whitelist — small, rarely-changed list of trusted people, all with equal
// full access (no per-user role/permission split). Must match the same env var value across
// all four services.
const AUTHORIZED_EMAILS = (process.env.AUTHORIZED_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const SESSION_COOKIE = 'gi_sid';
const CSRF_COOKIE = 'csrf_token';
// Marks that we already sent this browser to the central service for a handoff token. See
// the loop breaker in the auth gate below.
const HANDOFF_TRY_COOKIE = 'gi_hs';
const SESSION_TTL_SEC = 12 * 60 * 60;
if (!AUTH_SECRET) console.error('WARNING: AUTH_SIGNING_SECRET is not set — every request will be treated as unauthenticated.');

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// Cookie flags and this service's own origin come from configuration, never from request
// headers: Host and X-Forwarded-Proto are both attacker-settable, and deriving the Secure
// flag from X-Forwarded-Proto let anyone strip it off an issued cookie.
const IS_PROD =
  process.env.NODE_ENV === 'production' ||
  !!process.env.RAILWAY_PROJECT_ID ||
  !!process.env.RAILWAY_ENVIRONMENT_NAME;
const SELF_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://globe-invest.up.railway.app';
const ALLOWED_HOSTS = new Set([new URL(SELF_ORIGIN).host.toLowerCase(), 'globe-invest.up.railway.app']);
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1)(:\d+)?$/;

function selfOrigin(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!IS_PROD && LOCAL_HOST_RE.test(host)) return 'http://' + host;
  if (ALLOWED_HOSTS.has(host)) return 'https://' + host;
  return SELF_ORIGIN;
}

function getSessionEmail(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  // verifyFor derives the key from the audience, so a token minted for any other service
  // cannot produce a valid signature here. Previously this checked neither aud nor typ,
  // and the session cookie minted below carried no aud at all — making it a universal key
  // accepted by every sibling service that also skipped the check.
  const payload = auth.verifyFor(cookies[SESSION_COOKIE], AUTH_SECRET, {
    aud: selfOrigin(req),
    typ: auth.TYP_SESSION,
  });
  if (!payload || !payload.email || !AUTHORIZED_EMAILS.includes(payload.email.toLowerCase())) return null;
  return payload.email;
}

// Double-submit CSRF check for mutating (POST) endpoints: the session-establishing
// response also sets a non-httpOnly csrf_token cookie; the frontend must echo it back as
// an X-CSRF-Token header on every mutating request. A cross-site attacker can trigger the
// request but can't read the cookie to put its value in the header.
function csrfOk(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  const cookieTok = cookies[CSRF_COOKIE];
  const headerTok = req.headers['x-csrf-token'];
  return !!cookieTok && !!headerTok && cookieTok === headerTok;
}

const authFailLimiter = auth.makeRateLimiter({ windowMs: 10 * 60 * 1000, max: 30 });
const DATA_FILE = path.join(DATA_DIR, 'invest-data.json');
const GROUPS_FILE = path.join(DATA_DIR, 'invest-groups.json');
const CAUSAL_FILE = path.join(DATA_DIR, 'causal-files.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Referer': 'https://finance.yahoo.com/',
};

// Yahoo Finance symbols
const SYMBOLS = { wti: 'CL%3DF', brent: 'BZ%3DF', ng: 'NG%3DF', ttf: 'TTF%3DF', rbob: 'RB%3DF', ho: 'HO%3DF' };
const OIL_STALE_SEC = 20 * 60; // data older than this without a fresh tick is treated as closed

let _oilCache = null;
let _oilCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Stale-while-revalidate wrapper ───────────────────────────────────────────
// The TWSE / TPEx OpenAPI list feeds (STOCK_DAY_ALL ~300 KB, tpex quotes ~350 KB,
// BWIBBU_ALL, the company-info datasets) are slow to pull from Railway's US-East
// region — a cold fan-out runs ~25-30 s. With a plain TTL, the first visitor after
// the TTL lapses (and everyone, right after a container restart) pays that wait
// synchronously, and Railway's edge 502s the request before it returns. This wraps
// a zero-arg async builder so that past `ttl` the last good value is returned
// immediately and refreshed in the background; the blocking path runs only on a
// true cold start (no value yet, or older than `hardTtl`), and concurrent cold
// callers share one in-flight fetch. A failed background refresh keeps serving the
// previous value.
function swrCache(fn, ttl, hardTtl) {
  hardTtl = hardTtl || Infinity;
  let value, ts = 0, inflight = null;
  const run = () => {
    if (!inflight) {
      inflight = Promise.resolve().then(fn)
        .then(v => { value = v; ts = Date.now(); return v; })
        .catch(e => { console.warn('swrCache refresh failed:', e && e.message); throw e; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  };
  return async () => {
    const age = Date.now() - ts;
    if (value !== undefined && age < ttl) return value;
    if (value !== undefined && age < hardTtl) { run().catch(() => {}); return value; }
    return run();
  };
}

// Sub-industry → broad sector mapping (for 高價股 page)
const SECTOR_MAP = {
  '半導體業':'電子','電腦及週邊設備業':'電子','光電業':'電子','通訊網路業':'電子',
  '電子零組件業':'電子','電子通路業':'電子','資訊服務業':'電子','其他電子業':'電子',
  '數位雲端':'電子','綠能環保':'能源','油電燃氣業':'能源',
  '水泥工業':'傳產','食品工業':'傳產','塑膠工業':'傳產','紡織纖維':'傳產',
  '機械工業':'傳產','電機機械':'傳產','電器電纜':'傳產','化學工業':'傳產',
  '玻璃陶瓷':'傳產','造紙工業':'傳產','鋼鐵工業':'傳產','橡膠工業':'傳產','汽車工業':'傳產',
  '金融保險':'金融','建材營造':'建材','建設業':'建材','航運業':'航運',
  '生技醫療':'生技','化學生技醫療':'生技','農業科技業':'生技',
  '觀光餐旅':'服務','貿易百貨':'服務','電商業':'服務','文化創意業':'服務',
  '運動休閒':'服務','居家生活':'服務',
};

// TPEx industry code → Chinese name (上櫃產業分類)
const TPEX_INDUSTRY = {
  '01':'食品工業','02':'塑膠工業','03':'紡織纖維','04':'機械工業',
  '05':'電機機械','06':'電器電纜','08':'化學生技醫療','09':'玻璃陶瓷',
  '10':'造紙工業','11':'鋼鐵工業','12':'橡膠工業','14':'建材營造',
  '15':'航運業','16':'觀光餐旅','17':'金融保險','18':'貿易百貨',
  '20':'油電燃氣業','21':'半導體業','22':'電腦及週邊設備業',
  '23':'光電業','24':'通訊網路業','25':'電子零組件業',
  '26':'電子通路業','27':'資訊服務業','28':'其他電子業',
  '29':'建設業','30':'文化創意業','31':'農業科技業',
  '32':'電商業','33':'綠能環保','34':'數位雲端',
  '35':'運動休閒','36':'居家生活','37':'其他',
};

// TAIEX index closes cache (30 min) — for beta calculation
let _taiexCache = null, _taiexTime = 0;
async function getTaiexCloses() {
  if (_taiexCache && Date.now() - _taiexTime < 30 * 60 * 1000) return _taiexCache;
  try {
    const raw = await fetchUrl('https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1d&range=3mo&includePrePost=false');
    const d   = JSON.parse(raw);
    const r   = d.chart && d.chart.result && d.chart.result[0];
    if (!r) return null;
    _taiexCache = (r.indicators.quote[0]?.close || []).filter(v => v != null);
    _taiexTime  = Date.now();
    return _taiexCache;
  } catch { return null; }
}

function calcBeta(sCloses, iCloses) {
  const len = Math.min(sCloses.length, iCloses.length);
  if (len < 15) return null;
  const sc = sCloses.slice(-len), ic = iCloses.slice(-len);
  const sr = [], ir = [];
  for (let i = 1; i < len; i++) {
    if (sc[i] == null || sc[i-1] == null || ic[i] == null || ic[i-1] == null) continue;
    sr.push((sc[i] - sc[i-1]) / sc[i-1]);
    ir.push((ic[i] - ic[i-1]) / ic[i-1]);
  }
  const n = Math.min(sr.length, ir.length);
  if (n < 10) return null;
  const mS = sr.reduce((a,b)=>a+b,0)/n, mI = ir.reduce((a,b)=>a+b,0)/n;
  let cov = 0, varI = 0;
  for (let i = 0; i < n; i++) { cov += (sr[i]-mS)*(ir[i]-mI); varI += (ir[i]-mI)**2; }
  return varI ? +(cov/varI).toFixed(2) : null;
}

// High-price stock list — 10 min fresh, served stale up to 1 h while refreshing
let _rtCache = null, _rtTime = 0;   // real-time quote cache (20 s)
async function _buildHighPriceList() {
  const coInfo = await getCompanyInfo();
  const [twseRes, tpexRes, bwibRes] = await Promise.allSettled([
    fetchUrl('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL').then(JSON.parse),
    fetchUrl('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes').then(JSON.parse),
    fetchUrl('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL').then(JSON.parse),
  ]);
  // Build P/E & P/B map for TWSE stocks
  const pemap = {};
  if (bwibRes.status === 'fulfilled' && Array.isArray(bwibRes.value)) {
    for (const r of bwibRes.value) {
      const c = (r.Code||'').trim();
      if (c) pemap[c] = { pe: parseFloat(r.PEratio)||null, pb: parseFloat(r.PBratio)||null };
    }
  }
  const stocks = [];
  if (twseRes.status === 'fulfilled' && Array.isArray(twseRes.value)) {
    for (const r of twseRes.value) {
      const code  = (r.Code || '').trim();
      if (code.length !== 4 || !/^\d+$/.test(code)) continue;
      const price = parseFloat(r.ClosingPrice);
      if (!price || price <= 250) continue;
      const chg   = parseFloat(r.Change) || 0;
      const prev  = price - chg;
      const info  = coInfo[code] || {};
      const mcap  = info.shares > 0 ? Math.round(info.shares * price / 1e8) : null;
      const valu  = pemap[code] || { pe: null, pb: null };
      stocks.push({ code, name: (r.Name||'').trim(), market:'twse', price,
        change: +chg.toFixed(2), changePct: prev ? +(chg/prev*100).toFixed(2) : 0,
        industry: SECTOR_MAP[info.industry] || '其他', subIndustry: info.industry || '',
        marketCapYi: mcap, pe: valu.pe, pb: valu.pb });
    }
  }
  if (tpexRes.status === 'fulfilled' && Array.isArray(tpexRes.value)) {
    for (const r of tpexRes.value) {
      const code  = (r.SecuritiesCompanyCode || '').trim();
      if (code.length !== 4 || !/^\d+$/.test(code)) continue;
      const price = parseFloat(r.Close);
      if (!price || price <= 250) continue;
      const chg   = parseFloat(r.Change) || 0;
      const prev  = price - chg;
      const info  = coInfo[code] || {};
      const mcap  = info.shares > 0 ? Math.round(info.shares * price / 1e8) : null;
      stocks.push({ code, name: (r.CompanyName||'').trim(), market:'tpex', price,
        change: +chg.toFixed(2), changePct: prev ? +(chg/prev*100).toFixed(2) : 0,
        industry: SECTOR_MAP[info.industry] || '其他', subIndustry: info.industry || '',
        marketCapYi: mcap, pe: null, pb: null });
    }
  }
  stocks.sort((a,b) => b.price - a.price);
  return stocks;
}
const getHighPriceList = swrCache(_buildHighPriceList, 10 * 60 * 1000, 60 * 60 * 1000);

// Company info (industry / shares) — 1 h fresh, served stale up to 6 h while refreshing
async function _buildCompanyInfo() {
  const info = {};
  const [twseIndRes, tpexRes, twseCorpRes] = await Promise.allSettled([
    fetchUrl('https://openapi.twse.com.tw/v1/opendata/t187ap14_L').then(JSON.parse),
    fetchUrl('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O').then(JSON.parse),
    fetchUrl('https://openapi.twse.com.tw/v1/opendata/t187ap03_L').then(JSON.parse),
  ]);
  if (twseIndRes.status === 'fulfilled' && Array.isArray(twseIndRes.value)) {
    for (const r of twseIndRes.value) {
      const code = r['公司代號'] || '';
      if (code) info[code] = { industry: r['產業別'] || '', market: 'twse', shares: 0 };
    }
  }
  if (tpexRes.status === 'fulfilled' && Array.isArray(tpexRes.value)) {
    for (const r of tpexRes.value) {
      const code   = r['SecuritiesCompanyCode'] || '';
      const ind    = TPEX_INDUSTRY[r['SecuritiesIndustryCode']] || '';
      const shares = parseInt(r['IssueShares'] || '0') || 0;
      if (code) info[code] = { industry: ind, market: 'tpex', shares };
    }
  }
  // Overwrite TWSE shares from t187ap03_L (has 已發行普通股數)
  if (twseCorpRes.status === 'fulfilled' && Array.isArray(twseCorpRes.value)) {
    for (const r of twseCorpRes.value) {
      const code   = r['公司代號'] || '';
      const shares = parseInt(r['已發行普通股數或TDR原股發行股數'] || '0') || 0;
      if (code && info[code]) info[code].shares = shares;
      else if (code)          info[code] = { industry: '', market: 'twse', shares };
    }
  }
  return info;
}
const getCompanyInfo = swrCache(_buildCompanyInfo, 60 * 60 * 1000, 6 * 60 * 60 * 1000);

// Warning alerts cache (5 min TTL — intraday market alerts)
const _warnCache = {};
const _warnTime  = {};
const _warnInflight = {};   // per-key in-flight refresh, to coalesce concurrent cold callers

// OpenGraph metadata cache (24h TTL — CausalFrame embed preview cards)
const _ogCache = {};
const _ogTime  = {};
const WARN_APIS  = {
  'twse-notice':  'https://openapi.twse.com.tw/v1/announcement/notice',
  'twse-punish':  'https://openapi.twse.com.tw/v1/announcement/punish',
  'tpex-notice':  'https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information',
  'tpex-dispose': 'https://www.tpex.org.tw/openapi/v1/tpex_disposal_information',
  'tpex-3insti':  'https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading',
  'twse-3insti':  'https://openapi.twse.com.tw/v1/exchangeReport/MI_3INSTI',
  'twse-exdiv':   'https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL',
  'tpex-exdiv':   'https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost',
  'twse-stock-day-all':     'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  'tpex-mainboard-quotes':  'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
};

function _refreshWarn(key) {
  if (!_warnInflight[key]) {
    _warnInflight[key] = fetchUrl(WARN_APIS[key])
      .then(raw => {
        const data = JSON.parse(raw);
        _warnCache[key] = Array.isArray(data) ? data : [];
        _warnTime[key]  = Date.now();
        return _warnCache[key];
      })
      .finally(() => { _warnInflight[key] = null; });
  }
  return _warnInflight[key];
}

// Stale-while-revalidate, same rationale as swrCache() above: the STOCK_DAY_ALL /
// tpex-mainboard feeds behind 漲跌分佈 are slow from US-East, so past the TTL we
// serve the last good array at once and refresh in the background. Only a true cold
// key (never fetched) blocks, and concurrent cold callers share one fetch.
async function getWarnData(key) {
  const age = Date.now() - (_warnTime[key] || 0);
  if (_warnCache[key] !== undefined && age < CACHE_TTL) return _warnCache[key];
  if (_warnCache[key] !== undefined) { _refreshWarn(key).catch(() => {}); return _warnCache[key]; }
  return _refreshWarn(key);
}

function fetchMis(url) {
  return new Promise((resolve, reject) => {
    const hdrs = { ...BROWSER_HEADERS, 'Referer': 'https://mis.twse.com.tw/' };
    const req = https.get(url, { headers: hdrs }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const enc = res.headers['content-encoding'] || '';
      let stream = res;
      if (enc.includes('br'))      stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
      else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/* ---------- Yahoo option chains (volatility surface) ---------- */

// Yahoo's v7 option endpoint answers 401 without a session cookie plus a crumb
// minted against that same cookie. Both are cheap to hold and only occasionally
// rotate, so cache the pair and re-mint on the next 401 rather than per request.
let _yCookie = null, _yCrumb = null, _yAuthTime = 0;
const Y_AUTH_TTL = 30 * 60 * 1000;

function fetchRaw(url, cookie) {
  return new Promise((resolve, reject) => {
    const headers = { ...BROWSER_HEADERS };
    delete headers['Accept-Encoding'];
    headers['Accept-Encoding'] = 'gzip, deflate';
    if (cookie) headers['Cookie'] = cookie;
    const req = https.get(url, { headers }, res => {
      const enc = res.headers['content-encoding'] || '';
      let stream = res;
      if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
      else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve({
        status: res.statusCode,
        setCookie: res.headers['set-cookie'],
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function yahooAuth(force) {
  if (!force && _yCrumb && Date.now() - _yAuthTime < Y_AUTH_TTL) {
    return { cookie: _yCookie, crumb: _yCrumb };
  }
  let cookie = '';
  for (const seed of ['https://fc.yahoo.com/', 'https://finance.yahoo.com/']) {
    try {
      const r = await fetchRaw(seed);
      if (r.setCookie && r.setCookie.length) {
        cookie = r.setCookie.map(s => s.split(';')[0]).join('; ');
        break;
      }
    } catch (_) { /* try the next seed */ }
  }
  if (!cookie) throw new Error('yahoo cookie unavailable');
  const cr = await fetchRaw('https://query1.finance.yahoo.com/v1/test/getcrumb', cookie);
  const crumb = (cr.body || '').trim();
  if (cr.status !== 200 || !crumb || crumb.length > 32) throw new Error('yahoo crumb unavailable');
  _yCookie = cookie; _yCrumb = crumb; _yAuthTime = Date.now();
  return { cookie, crumb };
}

async function yahooOptions(symbol, epoch) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { cookie, crumb } = await yahooAuth(attempt > 0);
    let url = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`
            + `?crumb=${encodeURIComponent(crumb)}`;
    if (epoch) url += `&date=${epoch}`;
    const r = await fetchRaw(url, cookie);
    if (r.status === 401 || r.status === 403) continue;   // stale crumb -> re-mint once
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    const parsed = JSON.parse(r.body);
    const result = parsed?.optionChain?.result?.[0];
    if (!result) throw new Error('no option chain for ' + symbol);
    return result;
  }
  throw new Error('yahoo rejected the crumb twice');
}

// Kept deliberately in step with projects/volatility-surface-viewer/fetch_options.py
// -- the offline snapshot script and this endpoint must filter identically, or the
// surface changes shape depending on where its data came from.
const VS_MONEYNESS = 0.35;
const VS_MIN_IV = 0.01, VS_MAX_IV = 3.0;
const VS_MIN_TIME_VALUE = 0.002;
const VS_MIN_POINTS = 8;
const VS_MIN_DTE = 4;

function vsCleanQuotes(rows, spot, side) {
  const best = new Map();
  for (const row of rows || []) {
    const iv = Number(row.impliedVolatility), strike = Number(row.strike);
    if (!(iv > VS_MIN_IV && iv < VS_MAX_IV) || !(strike > 0)) continue;
    const oi = Number(row.openInterest || 0), vol = Number(row.volume || 0);
    if (oi <= 0 && vol <= 0) continue;
    const k = Math.log(strike / spot);
    if (Math.abs(k) > VS_MONEYNESS) continue;
    const bid = Number(row.bid || 0), ask = Number(row.ask || 0);
    if (bid <= 0) continue;
    const mid = ask > 0 ? (bid + ask) / 2 : Number(row.lastPrice || 0);
    const intrinsic = side === 'calls' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
    if (mid - intrinsic < VS_MIN_TIME_VALUE * spot) continue;
    const prev = best.get(strike);
    if (!prev || oi + vol > prev.liq) best.set(strike, { k, iv, liq: oi + vol });
  }
  return [...best.values()]
    .sort((a, b) => a.k - b.k)
    .map(p => [Number(p.k.toFixed(6)), Number(p.iv.toFixed(6))]);
}

async function buildVolSurface(symbol, maxExpiries) {
  const head = await yahooOptions(symbol);
  const spot = Number(head?.quote?.regularMarketPrice);
  if (!spot) throw new Error('no spot price for ' + symbol);

  const today = new Date();
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const epochs = (head.expirationDates || []).filter(e => {
    const dte = Math.round((e * 1000 - todayUTC) / 86400000);
    return dte >= VS_MIN_DTE;
  }).slice(0, maxExpiries);

  const calls = [], puts = [];
  for (const epoch of epochs) {
    let chain;
    try {
      chain = epoch === epochs[0] && head.options?.[0]?.expirationDate === epoch
        ? head : await yahooOptions(symbol, epoch);
    } catch (_) { continue; }
    const leg = chain.options?.[0];
    if (!leg) continue;
    const expiry = new Date(epoch * 1000).toISOString().slice(0, 10);
    const dte = Math.round((epoch * 1000 - todayUTC) / 86400000);
    for (const [side, bucket, rows] of
         [['calls', calls, leg.calls], ['puts', puts, leg.puts]]) {
      const points = vsCleanQuotes(rows, spot, side);
      if (points.length >= VS_MIN_POINTS) bucket.push({ expiry, dte, points });
    }
  }
  if (!calls.length && !puts.length) throw new Error('no usable quotes for ' + symbol);

  return {
    ticker: symbol.toUpperCase(),
    spot: Number(spot.toFixed(4)),
    fetched: new Date().toISOString(),
    calls, puts,
  };
}

function fetchUrl(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: BROWSER_HEADERS }, res => {
      // TWSE occasionally 302s an OpenAPI path to a canonical URL (and 404s a
      // retired one via redirect) — follow it, SSRF-guarded, same as fetchHtml().
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch (e) { return reject(new Error('bad redirect')); }
        if (isPrivateHost(new URL(next).hostname)) return reject(new Error('redirect to disallowed host'));
        return fetchUrl(next, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const enc = res.headers['content-encoding'] || '';
      let stream = res;
      if (enc.includes('br'))       stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
      else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Market Weather dashboard (Yahoo Finance-sourced macro stress proxies) ──
// Switched from FRED (official, key-gated) to Yahoo's unofficial chart endpoint — the same
// query1.finance.yahoo.com/v8/finance/chart/ host already used elsewhere in this file (see
// fetchSymbol/getTaiexCloses) — so no API key to provision, but also no uptime guarantee:
// this endpoint is undocumented and can change shape or start blocking datacenter IPs without
// notice. Each indicator is fetched independently and degrades to {error} on its own so one
// broken symbol doesn't blank the whole dashboard.
//
// Only 4 of the original 5 FRED series survive the switch:
//  - NFCI (Chicago Fed's ~100-variable composite financial-conditions index) has no
//    Yahoo/price-data equivalent at all and was dropped rather than faked.
//  - The 10Y-2Y curve became 10Y-3M (^TNX − ^IRX) — Yahoo has no 2-year Treasury yield
//    ticker; 10Y-3M is if anything the more standard inversion/recession signal academically.
//  - High-yield / investment-grade "spreads" are no longer true OAS spreads in bps (Yahoo has
//    no bond-spread data) — they're ETF price-ratio proxies (HYG/IEF, LQD/IEF) for credit
//    risk appetite. Ratio falling = credit weakening vs Treasuries = rising stress.
// `invert: true` marks indicators where a LOW raw value means HIGH stress (curve inversion,
// ratio deterioration) so the stress percentile direction is consistent with VIX (where high
// raw value = high stress) before averaging into avgPercentile.
const MW_SERIES = [
  { id: 'VIX', label: '波動率指數 VIX', symbols: ['^VIX'], kind: 'level', invert: false,
    desc: '選擇權隱含波動率，市場恐慌程度的即時溫度計。數值越高代表市場預期未來波動越劇烈。' },
  { id: 'T10Y3M', label: '10年-3個月公債利差', symbols: ['^TNX', '^IRX'], kind: 'spread', invert: true,
    desc: '10年期減3個月期公債殖利率之差。轉負（倒掛）historically 是衰退的領先訊號之一，學術上比10年-2年利差更常被當作標準預測指標（Yahoo無2年期公債殖利率報價，故以此替代）。' },
  { id: 'HY_PROXY', label: '高收益債風險胃納（HYG/IEF 比值）', symbols: ['HYG', 'IEF'], kind: 'ratio', invert: true,
    desc: '高收益債ETF相對公債ETF的價格比值——非官方OAS利差基點數，是用ETF相對報酬走勢間接代理信用市場風險胃納。比值走低代表高收益債相對公債走弱，隱含風險胃納下降。' },
  { id: 'IG_PROXY', label: '投資級債風險胃納（LQD/IEF 比值）', symbols: ['LQD', 'IEF'], kind: 'ratio', invert: true,
    desc: '投資級公司債ETF相對公債ETF的價格比值——同樣是間接代理指標，非官方OAS利差基點數。比值走低代表投資級債相對公債走弱。' },
];
const MW_TTL = 60 * 60 * 1000; // 1 hour cache, caps how often concurrent visitors re-hit Yahoo
let _mwCache = null, _mwTime = 0;

async function fetchYahooCloses(symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
    '?interval=1d&range=2y&includePrePost=false';
  const raw = await fetchUrl(url);
  const data = JSON.parse(raw);
  const result = data.chart && data.chart.result && data.chart.result[0];
  if (!result) throw new Error('no chart data for ' + symbol);
  const timestamps = result.timestamp || [];
  const closes = (result.indicators.quote[0] || {}).close || [];
  const points = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    points.push({ date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10), value: closes[i] });
  }
  if (!points.length) throw new Error('no usable closes for ' + symbol);
  return points;
}

// Inner-joins two date-keyed series on date and combines each matched pair — used to turn
// two raw price/yield series into one derived spread or ratio series.
function combineSeries(seriesA, seriesB, combine) {
  const mapB = new Map(seriesB.map((p) => [p.date, p.value]));
  const out = [];
  for (const a of seriesA) {
    const b = mapB.get(a.date);
    if (b === undefined) continue;
    out.push({ date: a.date, value: combine(a.value, b) });
  }
  return out;
}

async function fetchMwIndicator(spec) {
  let history;
  if (spec.symbols.length === 1) {
    history = await fetchYahooCloses(spec.symbols[0]);
  } else {
    const [a, b] = await Promise.all(spec.symbols.map(fetchYahooCloses));
    // ^TNX / ^IRX closes are already actual yield percentages (e.g. 4.68 == 4.68%),
    // no ×10/×1000 rescaling needed — verified directly against the live endpoint.
    const combine = spec.kind === 'spread' ? (av, bv) => av - bv : (av, bv) => av / bv;
    history = combineSeries(a, b, combine);
  }
  if (history.length < 2) throw new Error('insufficient overlapping data for ' + spec.id);
  history = history.slice(-260);

  const latestPoint = history[history.length - 1];
  const sortedVals = history.map((p) => p.value).slice().sort((x, y) => x - y);
  const rank = sortedVals.filter((v) => v <= latestPoint.value).length;
  let percentile = Math.round((rank / sortedVals.length) * 100);
  if (spec.invert) percentile = 100 - percentile;

  return { latest: latestPoint.value, latestDate: latestPoint.date, history, percentile };
}

async function getMarketWeather() {
  if (_mwCache && Date.now() - _mwTime < MW_TTL) return _mwCache;
  const results = await Promise.allSettled(MW_SERIES.map(fetchMwIndicator));
  const indicators = MW_SERIES.map((s, i) => {
    const r = results[i];
    if (r.status === 'fulfilled') return { id: s.id, label: s.label, desc: s.desc, error: null, ...r.value };
    return { id: s.id, label: s.label, desc: s.desc, error: r.reason.message, latest: null, latestDate: null, history: [], percentile: null };
  });
  const ok = indicators.filter((x) => x.percentile !== null);
  const avgPercentile = ok.length ? Math.round(ok.reduce((a, x) => a + x.percentile, 0) / ok.length) : null;
  const result = { indicators, avgPercentile, updatedAt: new Date().toISOString() };
  _mwCache = result;
  _mwTime = Date.now();
  return result;
}

// ── OpenGraph metadata fetch (CausalFrame embed preview cards) ──
// Blocks the obvious SSRF vectors (loopback/private/link-local ranges) since this
// endpoint fetches whatever URL the client passes in. Not exhaustive (no DNS-rebind
// protection), but this is a personal-portfolio tool, not a multi-tenant service.
function isPrivateHost(hostname) {
  const h = (hostname || '').toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h.endsWith('.local')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

function fetchHtml(url, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = 3;
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    };
    const req = https.get(url, { headers }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch (e) { return reject(new Error('bad redirect')); }
        if (isPrivateHost(new URL(next).hostname)) return reject(new Error('redirect to disallowed host'));
        fetchHtml(next, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const enc = res.headers['content-encoding'] || '';
      let stream = res;
      if (enc.includes('br'))       stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
      else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
      const chunks = []; let total = 0;
      stream.on('data', c => {
        total += c.length;
        if (total <= 2e6) chunks.push(c);
        else stream.destroy();
      });
      const finish = () => resolve(Buffer.concat(chunks).toString('utf8'));
      stream.on('end', finish);
      stream.on('close', finish);
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function extractMetaTag(html, prop) {
  const re1 = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']*)["\']', 'i');
  const re2 = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']' + prop + '["\']', 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? m[1].trim() : '';
}

function decodeHtmlEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/g, "'");
}

async function fetchOgData(targetUrl) {
  const u = new URL(targetUrl);
  if (!/^https?:$/.test(u.protocol)) throw new Error('invalid protocol');
  if (isPrivateHost(u.hostname)) throw new Error('host not allowed');
  const html = await fetchHtml(targetUrl);
  const titleTagMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const ogTitle = extractMetaTag(html, 'og:title') || (titleTagMatch ? titleTagMatch[1] : '');
  const ogDesc = extractMetaTag(html, 'og:description') || extractMetaTag(html, 'description');
  let ogImage = extractMetaTag(html, 'og:image') || extractMetaTag(html, 'twitter:image');
  if (ogImage && !/^https?:\/\//i.test(ogImage)) {
    try { ogImage = new URL(ogImage, u.origin).toString(); } catch (e) { ogImage = ''; }
  }
  return {
    title: decodeHtmlEntities(ogTitle).slice(0, 200),
    description: decodeHtmlEntities(ogDesc).slice(0, 400),
    image: ogImage || '',
    domain: u.hostname.replace(/^www\./, ''),
  };
}

// Combines Yahoo's session window (currentTradingPeriod.regular) with tick staleness —
// futures don't reliably set meta.marketState, so absence of a session window falls back
// to "closed if the last tick is old".
function computeMarketClosed(meta) {
  const nowSec = Date.now() / 1000;
  const rmt = meta.regularMarketTime || 0;
  const reg = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
  let inSession = null;
  if (reg && typeof reg.start === 'number' && typeof reg.end === 'number') {
    inSession = nowSec >= reg.start && nowSec < reg.end;
  }
  const stale = rmt > 0 && (nowSec - rmt) > OIL_STALE_SEC;
  return inSession === false || (inSession === null && stale);
}

async function fetchSymbol(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=30d&includePrePost=false`;
  const raw = await fetchUrl(url);
  const d = JSON.parse(raw);
  const res = d.chart.result[0];
  const closes = res.indicators.quote[0].close.filter(v => v != null);
  const meta = res.meta;
  // NOTE: meta.chartPreviousClose is the close BEFORE the requested range
  // (~30 trading days ago for range=30d) → using it yields a MONTHLY change, not daily.
  // These futures don't expose meta.previousClose, so derive the prior trading day's
  // close from the 1d-interval series itself (second-to-last bar).
  const prevClose = closes.length >= 2 ? closes[closes.length - 2]
                  : (meta.chartPreviousClose || closes[closes.length - 1]);
  return {
    price: meta.regularMarketPrice || closes[closes.length - 1],
    prev: prevClose,
    hist: closes.slice(-30),
    currency: meta.currency || 'USD',
    closed: computeMarketClosed(meta),
    asOf: meta.regularMarketTime || null,
  };
}

async function getOilPrices() {
  if (_oilCache && Date.now() - _oilCacheTime < CACHE_TTL) return _oilCache;
  const result = {};
  await Promise.allSettled(
    Object.entries(SYMBOLS).map(async ([k, sym]) => {
      try { result[k] = await fetchSymbol(sym); }
      catch (e) { result[k] = { error: e.message }; }
    })
  );
  _oilCache = result;
  _oilCacheTime = Date.now();
  return result;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  // ── Auth gate: everything except /research/* (the intentionally-public earnings call
  // reports) and Market Warning Radar (/warning, /high-price, and their /api/* endpoints —
  // made public 2026-08-31 so OutsideFramework's Tools picker page can link straight to them
  // with no login step) requires a valid local session or a fresh handoff token from the
  // central login service. Default-deny, allowlist the public exceptions — not the other way
  // around, so a new route added later is gated by default. ──
  const gatePath = req.url.split('?')[0];
  if (gatePath === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  const isPublicPath = gatePath.startsWith('/research/') ||
    gatePath === '/warning' || gatePath === '/warning/' ||
    gatePath === '/high-price' || gatePath === '/high-price/' ||
    gatePath.startsWith('/api/warning/') || gatePath.startsWith('/api/high-price/');
  if (!isPublicPath) {
    let email = getSessionEmail(req);
    if (!email) {
      const incomingUrl = new URL(req.url, selfOrigin(req));
      const incomingToken = incomingUrl.searchParams.get('auth');
      // aud and typ are both enforced, and the key is derived from aud — the hand-written
      // `tokenPayload.aud === selfOrigin(req)` comparison this replaces was correct but
      // was the only thing standing between a token for one service and a session on
      // another, and the sibling services' session path had no such comparison at all.
      const tokenPayload = incomingToken
        ? auth.verifyFor(incomingToken, AUTH_SECRET, { aud: selfOrigin(req), typ: auth.TYP_HANDOFF })
        : null;
      const tokenOk = tokenPayload && tokenPayload.email &&
        AUTHORIZED_EMAILS.includes(tokenPayload.email.toLowerCase());
      if (tokenOk) {
        // The local session now names its own audience and purpose. It used to carry
        // neither, which made this cookie a universal key across all four services.
        const sessionToken = auth.signFor(
          { email: tokenPayload.email.toLowerCase(), aud: selfOrigin(req), typ: auth.TYP_SESSION, exp: nowSec() + SESSION_TTL_SEC },
          AUTH_SECRET
        );
        const csrfToken = auth.randomToken(18);
        incomingUrl.searchParams.delete('auth');
        res.writeHead(302, {
          'Set-Cookie': [
            auth.cookieHeader(SESSION_COOKIE, sessionToken, { maxAgeSec: SESSION_TTL_SEC, httpOnly: true, secure: IS_PROD }),
            auth.cookieHeader(CSRF_COOKIE, csrfToken, { maxAgeSec: SESSION_TTL_SEC, httpOnly: false, secure: IS_PROD }),
            auth.clearCookieHeader(HANDOFF_TRY_COOKIE, { secure: IS_PROD }),
          ],
          Location: incomingUrl.pathname + (incomingUrl.search || ''),
        });
        res.end();
        return;
      }
      if (!authFailLimiter(auth.clientIp(req))) {
        res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Too many attempts. Try again later.');
        return;
      }
      // Loop breaker. Bouncing back to /auth/handoff is right when there was no token or
      // an expired one — the central service just mints a fresh one. But if a token that
      // WAS present still fails, minting another identical one will fail identically, and
      // the browser ping-pongs forever. That is exactly what a signing-scheme rollout
      // across four independently-deployed services produces mid-window, so fail loudly
      // once instead of looping.
      if (incomingToken && auth.parseCookies(req.headers.cookie)[HANDOFF_TRY_COOKIE]) {
        res.writeHead(503, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': auth.clearCookieHeader(HANDOFF_TRY_COOKIE, { secure: IS_PROD }),
        });
        res.end(
          '<h1>登入交接失敗</h1><p>中央登入服務簽發的憑證無法在此服務驗證。' +
          '若剛完成部署，請稍候一分鐘再重試。</p><p><a href="' + CENTRAL_AUTH_ORIGIN + '">回首頁</a></p>'
        );
        return;
      }
      incomingUrl.searchParams.delete('auth');
      const returnTo = selfOrigin(req) + incomingUrl.pathname + (incomingUrl.search || '');
      res.writeHead(302, {
        'Set-Cookie': auth.cookieHeader(HANDOFF_TRY_COOKIE, '1', { maxAgeSec: 120, httpOnly: true, secure: IS_PROD }),
        Location: CENTRAL_AUTH_ORIGIN + '/auth/handoff?return_to=' + encodeURIComponent(returnTo),
      });
      res.end();
      return;
    }
  }

  // Double-submit CSRF check applies to every mutating request once authenticated —
  // enforced here once instead of per-route so a future POST/PATCH/DELETE endpoint is
  // covered automatically instead of needing a remembered opt-in.
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !csrfOk(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: 'csrf' }));
    return;
  }

  if (req.url === '/api/oil-prices' && req.method === 'GET') {
    try {
      const data = await getOilPrices();
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Recent daily closes for arbitrary tickers (InvestFrame Kelly correlation auto-fetch).
  // Numeric codes are tried as TWSE (.TW) then TPEx (.TWO); anything else is used as-is
  // (Yahoo Finance ticker, e.g. AAPL). Response is keyed by the RAW ticker the caller sent.
  if (req.url.startsWith('/api/stock-history') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const tickers = (urlObj.searchParams.get('tickers') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
      const days = Math.max(2, Math.min(30, parseInt(urlObj.searchParams.get('days'), 10) || 14));
      if (!tickers.length) throw new Error('missing tickers');

      const result = {};
      await Promise.allSettled(tickers.map(async raw => {
        const cacheKey = `stkhist_${raw}`;
        if (_warnCache[cacheKey] !== undefined && Date.now() - (_warnTime[cacheKey] || 0) < 30 * 60 * 1000) {
          result[raw] = _warnCache[cacheKey];
          return;
        }
        const candidates = /^\d+$/.test(raw) ? [raw + '.TW', raw + '.TWO'] : [raw];
        for (const sym of candidates) {
          try {
            const { hist } = await fetchSymbol(sym);
            if (hist && hist.length >= 4) {
              const entry = { closes: hist.map(v => +v.toFixed(4)) };
              _warnCache[cacheKey] = entry; _warnTime[cacheKey] = Date.now();
              result[raw] = entry;
              return;
            }
          } catch (_) { /* try next candidate */ }
        }
        result[raw] = { error: 'not found' };
      }));
      // trim to requested window here (not cached) so a shorter `days` request doesn't need a re-fetch later
      Object.keys(result).forEach(k => { if (result[k].closes) result[k] = { closes: result[k].closes.slice(-days) }; });
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/api/invest-data' && req.method === 'GET') {
    const data = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : '{"macro":[],"risk":[],"industry":[]}';
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(data);
    return;
  }

  if (req.url === '/api/invest-data' && req.method === 'POST') {
    // Accumulate raw Buffers and decode ONCE at the end — appending chunks to a
    // string decodes each chunk separately and shatters multibyte UTF-8 (CJK)
    // characters that straddle chunk boundaries into U+FFFD mojibake.
    const chunks = []; let received = 0;
    req.on('data', c => { received += c.length; if (received <= 5e6) chunks.push(c); });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        JSON.parse(body);
        fs.writeFileSync(DATA_FILE, body, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/invest-groups' && req.method === 'GET') {
    const data = fs.existsSync(GROUPS_FILE) ? fs.readFileSync(GROUPS_FILE, 'utf8') : '{"macro":[],"risk":[],"industry":[]}';
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(data);
    return;
  }

  if (req.url === '/api/invest-groups' && req.method === 'POST') {
    const chunks = []; let received = 0;
    req.on('data', c => { received += c.length; if (received <= 5e6) chunks.push(c); });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        JSON.parse(body);
        fs.writeFileSync(GROUPS_FILE, body, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/causal-files' && req.method === 'GET') {
    const data = fs.existsSync(CAUSAL_FILE) ? fs.readFileSync(CAUSAL_FILE, 'utf8') : '[]';
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(data);
    return;
  }

  if (req.url === '/api/causal-files' && req.method === 'POST') {
    const chunks = []; let received = 0;
    req.on('data', c => { received += c.length; if (received <= 10e6) chunks.push(c); });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        JSON.parse(body);
        fs.writeFileSync(CAUSAL_FILE, body, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Reverse of CausalFrame's "insert earnings call report" node: for every report url,
  // which saved causal-files.json canvases (recursing into nested .isCanvas sub-graphs)
  // reference it. Lets a research report page show "referenced in N causal maps" instead
  // of that link only working one direction (causal map -> report).
  if (req.url === '/api/causal-backlinks' && req.method === 'GET') {
    try {
      const raw = fs.existsSync(CAUSAL_FILE) ? fs.readFileSync(CAUSAL_FILE, 'utf8') : '[]';
      const filesList = JSON.parse(raw);
      const index = {};
      function walk(nodes, fileId, fileName) {
        (nodes || []).forEach(n => {
          if (n.isEarningsRef && n.url) {
            (index[n.url] = index[n.url] || []).push({ fileId, fileName, ticker: n.ticker, period: n.period });
          }
          if (n.isCanvas && n.data) walk(n.data.nodes, fileId, fileName);
        });
      }
      filesList.forEach(f => walk((f.data || {}).nodes, f.id, f.name));
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(index));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Lists the published earnings-call reports under /research so CausalFrame's
  // "insert earnings call report" picker can offer them without hardcoding a list.
  if (req.url === '/api/research-reports' && req.method === 'GET') {
    try {
      const dir = path.join(APP_DIR, 'research');
      const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      const reports = names
        .map(fn => {
          const m = fn.match(/^([A-Z0-9]+)_(.+)_(Analysis|Financials)\.html$/);
          if (!m) return null;
          return { ticker: m[1], period: m[2], kind: m[3], filename: fn, url: '/research/' + fn };
        })
        .filter(Boolean)
        .sort((a, b) => a.ticker.localeCompare(b.ticker) || a.period.localeCompare(b.period) || a.kind.localeCompare(b.kind));
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(reports));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/api/market-weather' && req.method === 'GET') {
    try {
      const data = await getMarketWeather();
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // OpenGraph metadata for CausalFrame's link-preview embed cards
  if (req.url.startsWith('/api/fuelprice') && req.method === 'GET') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(await fuelprice.get()));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url.startsWith('/api/powergrid/') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const days = Math.min(730, Math.max(1,
        parseInt(urlObj.searchParams.get('days') || '30', 10) || 30));
      const what = urlObj.pathname.slice('/api/powergrid/'.length);
      let data;
      if (what === 'now') {
        // Serve the recorder's own last poll rather than refetching: the page and
        // the tape should never disagree about what the grid looked like.
        data = powerlog.latest || await powerlog.poll();
      }
      else if (what === 'history')  data = { days, rows: powerlog.history(days) };
      else if (what === 'findings') data = powerlog.findings(days);
      else if (what === 'status')   data = powerlog.status();
      else throw new Error('unknown view');
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url.startsWith('/api/volsurface') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const symbol = (urlObj.searchParams.get('ticker') || '').toUpperCase();
      // Symbols only: this value is interpolated into an upstream URL path.
      if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) throw new Error('bad ticker');
      const maxExpiries = Math.min(12, Math.max(4,
        parseInt(urlObj.searchParams.get('expiries') || '10', 10) || 10));

      const cacheKey = `vs_${symbol}_${maxExpiries}`;
      let data;
      // Chains move all session, but a surface built minutes apart looks the same;
      // 10 minutes keeps the page snappy without going stale in a way that matters.
      if (_warnCache[cacheKey] && Date.now() - (_warnTime[cacheKey] || 0) < 10 * 60 * 1000) {
        data = _warnCache[cacheKey];
      } else {
        data = await buildVolSurface(symbol, maxExpiries);
        _warnCache[cacheKey] = data; _warnTime[cacheKey] = Date.now();
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url.startsWith('/api/og-fetch') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const target = urlObj.searchParams.get('url') || '';
      if (!target) throw new Error('missing url');
      const cacheKey = 'og_' + target;
      let data;
      if (_ogCache[cacheKey] && Date.now() - (_ogTime[cacheKey] || 0) < 24 * 60 * 60 * 1000) {
        data = _ogCache[cacheKey];
      } else {
        data = await fetchOgData(target);
        _ogCache[cacheKey] = data; _ogTime[cacheKey] = Date.now();
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Image asset upload
  if (req.url === '/api/upload-asset' && req.method === 'POST') {
    const chunks = []; let received = 0;
    req.on('data', c => { received += c.length; if (received <= 20e6) chunks.push(c); });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const { data, ext } = JSON.parse(body);
        const base64 = data.includes(',') ? data.split(',')[1] : data;
        const buf = Buffer.from(base64, 'base64');
        const safeExt = (ext||'png').replace(/[^a-z0-9]/gi,'').slice(0,8)||'png';
        const id = crypto.randomUUID();
        const assetsDir = path.join(DATA_DIR, 'assets');
        if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
        const filename = id + '.' + safeExt;
        fs.writeFileSync(path.join(assetsDir, filename), buf);
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ url: '/api/asset/' + filename }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Image asset serve
  if (req.url.startsWith('/api/asset/') && req.method === 'GET') {
    const filename = path.basename(req.url.replace('/api/asset/', '')).replace(/[^a-zA-Z0-9._-]/g, '');
    const assetPath = path.join(DATA_DIR, 'assets', filename);
    try {
      const content = fs.readFileSync(assetPath);
      const ext = path.extname(filename).slice(1).toLowerCase();
      const mime = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml', bmp:'image/bmp' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public,max-age=31536000', ...CORS });
      res.end(content);
    } catch (e) { res.writeHead(404); res.end('Not found'); }
    return;
  }

  // ── High-price stock list ───────────────────────────────────────
  if (req.url === '/api/high-price/list' && req.method === 'GET') {
    try {
      const list = await getHighPriceList();
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(list));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── High-price real-time quotes (Yahoo Finance meta.regularMarketPrice, 20 s cache) ──
  if (req.url === '/api/high-price/realtime' && req.method === 'GET') {
    if (_rtCache && Date.now() - _rtTime < 20000) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      return res.end(JSON.stringify(_rtCache));
    }
    try {
      const stocks = await getHighPriceList();
      const result = {};
      let idx = 0;
      const CONC = 20;
      const worker = async () => {
        while (idx < stocks.length) {
          const s = stocks[idx++];
          const sym = s.market === 'twse' ? `${s.code}.TW` : `${s.code}.TWO`;
          try {
            const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`;
            const raw  = await fetchUrl(url);
            const data = JSON.parse(raw);
            const meta = data.chart?.result?.[0]?.meta;
            if (!meta?.regularMarketPrice) continue;
            const price = meta.regularMarketPrice;
            const prev  = meta.chartPreviousClose || meta.previousClose;
            if (!prev) continue;
            // Taiwan local time from regularMarketTime (UTC+8)
            const t   = new Date((meta.regularMarketTime || 0) * 1000 + 8 * 3600 * 1000);
            const hh  = String(t.getUTCHours()).padStart(2, '0');
            const mm  = String(t.getUTCMinutes()).padStart(2, '0');
            result[s.code] = {
              price:     +price.toFixed(2),
              change:    +(price - prev).toFixed(2),
              changePct: +((price - prev) / prev * 100).toFixed(2),
              time: `${hh}:${mm}`,
            };
          } catch (_) { /* skip failed stock */ }
        }
      };
      await Promise.all(Array.from({ length: CONC }, worker));
      _rtCache = result; _rtTime = Date.now();
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── High-price metrics: 5d/30d change + beta (Yahoo Finance + ^TWII) ──
  if (req.url.startsWith('/api/high-price/metrics') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const market = urlObj.searchParams.get('market') || '';
      const code   = urlObj.searchParams.get('code')   || '';
      if (!market || !code) throw new Error('missing params');

      const cacheKey = `hp_${market}_${code}`;
      if (_warnCache[cacheKey] !== undefined && Date.now() - (_warnTime[cacheKey]||0) < 30*60*1000) {
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify(_warnCache[cacheKey])); return;
      }

      const suffix = market === 'twse' ? '.TW' : '.TWO';
      const sym    = encodeURIComponent(code + suffix);
      const [stockRaw, taiex] = await Promise.all([
        fetchUrl(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3mo&includePrePost=false`),
        getTaiexCloses(),
      ]);
      const yData  = JSON.parse(stockRaw);
      const result = yData.chart && yData.chart.result && yData.chart.result[0];
      if (!result) {
        _warnCache[cacheKey] = null; _warnTime[cacheKey] = Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end('null'); return;
      }

      const closes = (result.indicators.quote[0]?.close || []).filter(v => v != null);
      const last   = closes[closes.length - 1];
      const c5ref  = closes.length >= 6  ? closes[closes.length - 6]  : null;
      const c30ref = closes.length >= 2  ? closes[0]                  : null;
      const change5d  = c5ref  ? +(((last - c5ref)  / c5ref)  * 100).toFixed(2) : null;
      const change30d = c30ref ? +(((last - c30ref) / c30ref) * 100).toFixed(2) : null;
      const beta      = taiex  ? calcBeta(closes, taiex) : null;
      const hist30    = closes.slice(-30).map(v => +v.toFixed(2));

      // ── Extra analytics ──────────────────────────────────────────────
      // Consecutive down days (from today backwards)
      let consecutiveDown = 0;
      for (let i = closes.length - 1; i > 0; i--) {
        if (closes[i] < closes[i - 1]) consecutiveDown++;
        else break;
      }
      // Down days in last 5 trading days
      let downDays5 = 0;
      for (let i = Math.max(1, closes.length - 5); i < closes.length; i++) {
        if (closes[i] < closes[i - 1]) downDays5++;
      }
      // Down days in last ~22 trading days (1 month)
      let downDays22 = 0;
      const m22start = Math.max(1, closes.length - 22);
      for (let i = m22start; i < closes.length; i++) {
        if (closes[i] < closes[i - 1]) downDays22++;
      }
      const tradeDays22 = closes.length - m22start; // actual trading days in window
      // Drawdown from 3-month high
      const highPrice  = Math.max(...closes);
      const ddFromHigh = highPrice > 0 ? +(((last - highPrice) / highPrice) * 100).toFixed(2) : null;

      // ── 20MA 偏離度% ─────────────────────────────────────────────────
      const ma20arr = closes.slice(-20);
      const ma20    = ma20arr.reduce((a, b) => a + b, 0) / ma20arr.length;
      const ma20dev = +((last - ma20) / ma20 * 100).toFixed(2);

      // ── 相對強弱 vs 大盤 (stock 30d - TWII 30d) ────────────────────
      let relStrength = null;
      if (taiex && taiex.length >= 2 && change30d !== null) {
        const twiLast  = taiex[taiex.length - 1];
        const twiFirst = taiex[0];
        const twi30d   = +((twiLast - twiFirst) / twiFirst * 100).toFixed(2);
        relStrength = +(change30d - twi30d).toFixed(2);
      }

      // ── 歷史波動度 (年化, log returns ×√252) ────────────────────────
      let hv = null;
      const retArr = [];
      for (let i = Math.max(1, closes.length - 30); i < closes.length; i++) {
        if (closes[i] > 0 && closes[i - 1] > 0)
          retArr.push(Math.log(closes[i] / closes[i - 1]));
      }
      if (retArr.length >= 10) {
        const mean = retArr.reduce((a, b) => a + b, 0) / retArr.length;
        const variance = retArr.reduce((a, b) => a + (b - mean) ** 2, 0) / (retArr.length - 1);
        hv = +(Math.sqrt(variance * 252) * 100).toFixed(1);
      }

      const payload = { change5d, change30d, beta, hist30,
        consecutiveDown, downDays5, downDays22, tradeDays22, ddFromHigh, highPrice: +highPrice.toFixed(2),
        ma20dev, relStrength, hv };
      _warnCache[cacheKey] = payload; _warnTime[cacheKey] = Date.now();
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(payload));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Company info (industry classification) — 1h cache
  if (req.url === '/api/warning/company-info' && req.method === 'GET') {
    try {
      const info = await getCompanyInfo();
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(info));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Price change for all warning stocks (Yahoo Finance .TW / .TWO)
  // startDate is optional — when absent, changePct = last-30d change
  if (req.url.startsWith('/api/warning/price-change') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const market    = urlObj.searchParams.get('market') || '';
      const code      = urlObj.searchParams.get('code')   || '';
      const startDate = urlObj.searchParams.get('startDate') || ''; // YYYYMMDD, optional
      if (!market || !code) throw new Error('missing params');

      const cacheKey = `price_${market}_${code}_${startDate}`;
      if (_warnCache[cacheKey] !== undefined && Date.now() - (_warnTime[cacheKey] || 0) < 30 * 60 * 1000) {
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify(_warnCache[cacheKey]));
        return;
      }

      const suffix = market === 'twse' ? '.TW' : '.TWO';
      const sym    = encodeURIComponent(code + suffix);
      const yUrl   = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3mo&includePrePost=false`;
      const raw    = await fetchUrl(yUrl);
      const yData  = JSON.parse(raw);
      const result = yData.chart && yData.chart.result && yData.chart.result[0];

      if (!result) {
        _warnCache[cacheKey] = null; _warnTime[cacheKey] = Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end('null'); return;
      }

      const timestamps = result.timestamp || [];
      const closes     = (result.indicators.quote[0] || {}).close || [];
      const hist30     = closes.filter(v => v != null).slice(-30).map(v => +v.toFixed(2));

      let startPrice = null, currentPrice = null;
      if (startDate) {
        const sd = startDate;
        const startTs = Math.floor(new Date(`${sd.slice(0,4)}-${sd.slice(4,6)}-${sd.slice(6,8)}T00:00:00+08:00`).getTime() / 1000);
        for (let i = 0; i < timestamps.length; i++) {
          if (closes[i] == null) continue;
          if (startPrice === null && timestamps[i] >= startTs) startPrice = closes[i];
          currentPrice = closes[i];
        }
      } else {
        // No startDate: use first and last valid close in the 30-day window
        startPrice   = hist30[0]            || null;
        currentPrice = hist30[hist30.length - 1] || null;
      }

      if (!startPrice || !currentPrice) {
        _warnCache[cacheKey] = null; _warnTime[cacheKey] = Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end('null'); return;
      }

      const changePct = (currentPrice - startPrice) / startPrice * 100;
      const payload   = { startPrice: +startPrice.toFixed(2), currentPrice: +currentPrice.toFixed(2), changePct: +changePct.toFixed(2), hist: hist30 };
      _warnCache[cacheKey] = payload; _warnTime[cacheKey] = Date.now();
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(payload));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Warning API proxy
  const warnKey = {
    '/api/warning/twse-notice':  'twse-notice',
    '/api/warning/twse-punish':  'twse-punish',
    '/api/warning/tpex-notice':  'tpex-notice',
    '/api/warning/tpex-dispose': 'tpex-dispose',
    '/api/warning/tpex-3insti':  'tpex-3insti',
    '/api/warning/twse-3insti':  'twse-3insti',
    '/api/warning/twse-exdiv':   'twse-exdiv',
    '/api/warning/tpex-exdiv':   'tpex-exdiv',
    '/api/warning/twse-stock-day-all':    'twse-stock-day-all',
    '/api/warning/tpex-mainboard-quotes': 'tpex-mainboard-quotes',
  }[req.url];
  if (warnKey && req.method === 'GET') {
    try {
      const data = await getWarnData(warnKey);
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  let fp;
  const url = req.url.split('?')[0];
  if (url === '/globe' || url === '/globe/')     fp = path.join(APP_DIR, 'globe',   'index.html');
  else if (url === '/invest' || url === '/invest/')   fp = path.join(APP_DIR, 'invest',  'index.html');
  else if (url === '/causal' || url === '/causal/')   fp = path.join(APP_DIR, 'causal',  'index.html');
  else if (url === '/warning'    || url === '/warning/')    fp = path.join(APP_DIR, 'warning',    'index.html');
  else if (url === '/high-price' || url === '/high-price/') fp = path.join(APP_DIR, 'high-price', 'index.html');
  else if (url === '/options'    || url === '/options/')    fp = path.join(APP_DIR, 'options',    'index.html');
  else if (url === '/brownian'   || url === '/brownian/')   fp = path.join(APP_DIR, 'brownian',   'index.html');
  else if (url === '/sankey'     || url === '/sankey/')     fp = path.join(APP_DIR, 'sankey',     'index.html');
  else if (url === '/earnings-quiz' || url === '/earnings-quiz/') fp = path.join(APP_DIR, 'earnings-quiz', 'index.html');
  else if (url === '/mounjaro' || url === '/mounjaro/') fp = path.join(APP_DIR, 'mounjaro', 'index.html');
  else if (url === '/agentic-ai' || url === '/agentic-ai/') fp = path.join(APP_DIR, 'agentic-ai', 'index.html');
  else if (url === '/aircraft-field-guide' || url === '/aircraft-field-guide/') fp = path.join(APP_DIR, 'aircraft-field-guide', 'index.html');
  else if (url === '/market-weather' || url === '/market-weather/') fp = path.join(APP_DIR, 'market-weather', 'index.html');
  // Unlike the other single-file apps this one fetches siblings by relative URL,
  // so it must be served from a trailing-slash path or those resolve to root.
  // Keep the query: the Works page arrives with ?auth=<handoff token>, and
  // redirecting to a bare path would strip it and bounce the visitor to login.
  else if (url === '/volsurface') {
    const qs = req.url.indexOf('?');
    res.writeHead(301, { Location: '/volsurface/' + (qs >= 0 ? req.url.slice(qs) : '') });
    res.end();
    return;
  }
  else if (url === '/volsurface/') fp = path.join(APP_DIR, 'volsurface', 'index.html');
  else if (url === '/powergrid' || url === '/powergrid/') fp = path.join(APP_DIR, 'powergrid', 'index.html');
  else if (url === '/fuelprice' || url === '/fuelprice/') fp = path.join(APP_DIR, 'fuelprice', 'index.html');
  else if (url === '/') { res.writeHead(301, { Location: '/globe' }); res.end(); return; }
  else fp = path.join(APP_DIR, url);

  try {
    const content = fs.readFileSync(fp);
    const ext = path.extname(fp);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // HTML is the app itself — always revalidate so deploys reach users immediately
    if (ext === '.html') headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(content);
  } catch (e) {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log('Listening on port ' + PORT);
  // The recorder's value is continuity, so it starts with the process rather than
  // on first page view — the archive has to accrue whether or not anyone visits.
  // Set POWERLOG_DISABLED=1 in a local checkout to avoid polling Taipower while
  // developing something unrelated.
  if (process.env.POWERLOG_DISABLED !== '1') powerlog.start();

  // Warm the slow TWSE/TPEx-backed caches now, so the first visitor after a restart
  // is served from cache instead of eating the ~25-30 s cold fan-out (which Railway's
  // edge would 502 before it returns). Fire-and-forget; swrCache keeps them warm after.
  // Set PRIME_DISABLED=1 locally to skip the trans-Pacific pull while developing.
  if (process.env.PRIME_DISABLED !== '1') {
    Promise.allSettled([
      getHighPriceList(),                        // also primes getCompanyInfo()
      getWarnData('twse-stock-day-all'),
      getWarnData('tpex-mainboard-quotes'),
    ]).then(rs => {
      const failed = rs.filter(r => r.status === 'rejected').length;
      if (failed) console.warn('cache prime: ' + failed + '/3 failed (retries on first request)');
    });
  }
});
