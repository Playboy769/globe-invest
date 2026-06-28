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
const SYMBOLS = { wti: 'CL%3DF', brent: 'BZ%3DF', ng: 'NG%3DF', rbob: 'RB%3DF', jet: 'HO%3DF' };

let _oilCache = null;
let _oilCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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

  if (req.url === '/api/invest-data' && req.method === 'GET') {
    const data = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : '{"macro":[],"risk":[],"industry":[]}';
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(data);
    return;
  }

  if (req.url === '/api/invest-data' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { if (body.length < 5e6) body += c; });
    req.on('end', () => {
      try {
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
    let body = '';
    req.on('data', c => { if (body.length < 5e6) body += c; });
    req.on('end', () => {
      try {
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
    let body = '';
    req.on('data', c => { if (body.length < 10e6) body += c; });
    req.on('end', () => {
      try {
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
    let body = '';
    req.on('data', c => { if (body.length < 20e6) body += c; });
    req.on('end', () => {
      try {
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

  // Price change for disposal stocks (Yahoo Finance .TW / .TWO)
  if (req.url.startsWith('/api/warning/price-change') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const market    = urlObj.searchParams.get('market')    || '';
      const code      = urlObj.searchParams.get('code')      || '';
      const startDate = urlObj.searchParams.get('startDate') || ''; // YYYYMMDD western
      if (!market || !code || !startDate) throw new Error('missing params');

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
      // start of disposal date in Taiwan timezone offset (UTC+8)
      const sd  = startDate;
      const startTs = Math.floor(new Date(`${sd.slice(0,4)}-${sd.slice(4,6)}-${sd.slice(6,8)}T00:00:00+08:00`).getTime() / 1000);

      let startPrice = null, currentPrice = null;
      for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] == null) continue;
        if (startPrice === null && timestamps[i] >= startTs) startPrice = closes[i];
        currentPrice = closes[i];
      }

      if (!startPrice || !currentPrice) {
        _warnCache[cacheKey] = null; _warnTime[cacheKey] = Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end('null'); return;
      }

      const changePct = (currentPrice - startPrice) / startPrice * 100;
      const payload   = { startPrice: +startPrice.toFixed(2), currentPrice: +currentPrice.toFixed(2), changePct: +changePct.toFixed(2) };
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
  else if (url === '/warning' || url === '/warning/') fp = path.join(APP_DIR, 'warning', 'index.html');
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
