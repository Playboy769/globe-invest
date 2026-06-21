const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DATA_DIR = '/data';
const APP_DIR = '/app';
const DATA_FILE = path.join(DATA_DIR, 'invest-data.json');

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
  return {
    price: meta.regularMarketPrice || closes[closes.length - 1],
    prev: meta.chartPreviousClose || closes[closes.length - 2],
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

  let fp;
  const url = req.url.split('?')[0];
  if (url === '/globe' || url === '/globe/') fp = path.join(APP_DIR, 'globe', 'index.html');
  else if (url === '/invest' || url === '/invest/') fp = path.join(APP_DIR, 'invest', 'index.html');
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
