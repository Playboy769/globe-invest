const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const DATA_DIR = '/data';
const APP_DIR = '/app';
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

// High-price stock list cache (10 min)
let _hpCache = null, _hpTime = 0;
// Real-time quote cache (20 s)
let _rtCache = null, _rtTime = 0;
async function getHighPriceList() {
  if (_hpCache && Date.now() - _hpTime < 10 * 60 * 1000) return _hpCache;
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
  _hpCache = stocks; _hpTime = Date.now();
  return stocks;
}

// Company info cache (1 hour TTL)
let _coInfoCache = null;
let _coInfoTime  = 0;

async function getCompanyInfo() {
  if (_coInfoCache && Date.now() - _coInfoTime < 60 * 60 * 1000) return _coInfoCache;
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
  _coInfoCache = info;
  _coInfoTime  = Date.now();
  return info;
}

// Warning alerts cache (5 min TTL — intraday market alerts)
const _warnCache = {};
const _warnTime  = {};
const WARN_APIS  = {
  'twse-notice':  'https://openapi.twse.com.tw/v1/announcement/notice',
  'twse-punish':  'https://openapi.twse.com.tw/v1/announcement/punish',
  'tpex-notice':  'https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information',
  'tpex-dispose': 'https://www.tpex.org.tw/openapi/v1/tpex_disposal_information',
  'tpex-3insti':  'https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading',
  'twse-3insti':  'https://openapi.twse.com.tw/v1/exchangeReport/MI_3INSTI',
  'twse-exdiv':   'https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL',
  'tpex-exdiv':   'https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost',
};

async function getWarnData(key) {
  if (_warnCache[key] && Date.now() - (_warnTime[key] || 0) < CACHE_TTL) return _warnCache[key];
  const raw  = await fetchUrl(WARN_APIS[key]);
  const data = JSON.parse(raw);
  _warnCache[key] = Array.isArray(data) ? data : [];
  _warnTime[key]  = Date.now();
  return _warnCache[key];
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

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: BROWSER_HEADERS }, res => {
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
  else if (url === '/') { res.writeHead(301, { Location: '/globe' }); res.end(); return; }
  else fp = path.join(APP_DIR, url);

  try {
    const content = fs.readFileSync(fp);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(content);
  } catch (e) {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, () => console.log('Listening on port ' + PORT));
