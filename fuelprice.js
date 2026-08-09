// fuelprice.js — turn CPC's fuel-price history page into something usable.
//
// The data is public but effectively unreadable: it ships as an 800KB ASP.NET
// page whose only content is one 620-row table, with no API, no CSV, and no
// chart. Everyone in Taiwan is affected by these numbers weekly and nobody can
// plot them. All this module does is parse that table and hand back JSON.
//
// Adding a module here means three edits, not one: the require in server.js, a
// COPY line in the Dockerfile, and an entry in .dockerignore (which is deny-all
// with a per-file allowlist). CI checks all three.

const https = require('https');
const zlib = require('zlib');

// Lowercase spelling is the canonical one; the mixed-case path 301s to it.
const SRC = 'https://vipmbr.cpc.com.tw/mbwebs/showhistoryprice_oil.aspx';

// Prices change weekly, on Sunday for the following Monday. Six hours is far
// finer than the data ever moves and keeps an 800KB fetch off the hot path.
const TTL_MS = 6 * 60 * 60 * 1000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let cache = null, cacheTime = 0, inflight = null;

function fetchPage(url = SRC, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*',
                 'Accept-Language': 'zh-TW,zh;q=0.9', 'Accept-Encoding': 'gzip, deflate' },
    }, res => {
      // The site canonicalises its own path casing, so a redirect here is
      // routine rather than a failure.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops >= 3) return reject(new Error('too many redirects'));
        return resolve(fetchPage(new URL(res.headers.location, url).href, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const enc = res.headers['content-encoding'] || '';
      let stream = res;
      if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
      else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

const strip = h => h.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
                    .replace(/&amp;/g, '&').trim();

function parseTable(html) {
  // The page holds a decorative table as well; the real one is simply the
  // biggest, so pick by row count rather than by a brittle id or position.
  let best = null, bestRows = 0;
  for (const m of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    const n = (m[0].match(/<tr/g) || []).length;
    if (n > bestRows) { bestRows = n; best = m[0]; }
  }
  if (!best) throw new Error('no table found');

  const rows = [];
  for (const m of best.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => strip(c[1]));
    if (cells.length) rows.push(cells);
  }
  if (rows.length < 2) throw new Error('table has no rows');
  return rows;
}

function build(html) {
  const rows = parseTable(html);
  const header = rows[0];
  const data = rows.slice(1)
    .filter(r => r.length === header.length && /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(r[0]));
  if (!data.length) throw new Error('no dated rows');

  const iso = s => {
    const [y, m, d] = s.split('/').map(Number);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  data.sort((a, b) => iso(a[0]).localeCompare(iso(b[0])));

  const products = [];
  for (let c = 1; c < header.length; c++) {
    const label = header[c];
    if (!label) continue;
    // Bulk marine and boiler fuels are quoted per kilolitre, three orders of
    // magnitude above the pump prices; they cannot share an axis.
    const bulk = /\(KL\)/i.test(label);
    const points = [];
    for (const r of data) {
      const v = r[c];
      if (!v || !/^\d/.test(v)) continue;
      const p = parseFloat(v.replace(/,/g, ''));
      if (!isFinite(p) || p <= 0) continue;
      points.push([iso(r[0]), p]);
    }
    if (points.length < 2) continue;
    products.push({
      key: 'p' + c,
      label: label.replace(/\(KL\)/i, '').trim(),
      unit: bulk ? '元/公秉' : '元/公升',
      group: bulk ? 'bulk' : 'road',
      points,
      latest: points[points.length - 1][1],
      latestDate: points[points.length - 1][0],
      min: Math.min(...points.map(p => p[1])),
      max: Math.max(...points.map(p => p[1])),
    });
  }
  if (!products.length) throw new Error('no product columns parsed');

  return {
    source: SRC,
    fetched: new Date().toISOString(),
    from: iso(data[0][0]),
    to: iso(data[data.length - 1][0]),
    rows: data.length,
    products,
  };
}

async function get() {
  if (cache && Date.now() - cacheTime < TTL_MS) return cache;
  // Collapse concurrent misses onto one upstream fetch; the page is 800KB and
  // several visitors landing together should not each pull their own copy.
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = build(await fetchPage());
      cache = data; cacheTime = Date.now();
      return data;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

module.exports = { get, _build: build };
