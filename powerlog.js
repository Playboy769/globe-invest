// powerlog.js — passive recorder for Taipower's live grid feeds.
//
// The point of this module is duration, not the snapshot. Taipower publishes what
// the grid looks like right now and overwrites it ten minutes later; nobody keeps
// the tape. Questions like "which unit sits in 檢修 for months at a time" or "how
// often is wind actually curtailed" are unanswerable from any single fetch, and
// become trivial once somebody has simply been writing it all down.
//
// Storage is append-only NDJSON on the Railway volume rather than SQLite, because
// the image is node:20-alpine and node:sqlite needs 22.13+. Bumping the base image
// of a live service to gain a database this small does not pay for itself: the
// whole archive runs about 20MB/year.
//
// Written to match the house style of server.js/analytics.js — plain callbacks-free
// async, no dependencies, everything in one file.

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const DATA_DIR = process.env.POWERLOG_DATA_DIR || '/data';
const DIR = path.join(DATA_DIR, 'powerlog');

const UNITS_URL = 'https://service.taipower.com.tw/data/opendata/apply/file/d006001/001.json';
const SYS_URL   = 'https://service.taipower.com.tw/data/opendata/apply/file/d006020/001.json';

// Taipower republishes on a 10-minute cadence; polling faster only re-reads the
// same numbers and spends someone else's bandwidth doing it.
const POLL_MS = 10 * 60 * 1000;
const RETAIN_MONTHS = 24;

// Taipower reports system-level figures in 萬瓩 (10 MW) but per-unit figures in MW.
const TENS_OF_MW_TO_MW = 10;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let lastState = new Map();   // unit name -> last recorded state string
let today = null;            // { day, units: Map(name -> accumulator) }
let latest = null;           // most recent poll result, served to the page
let lastError = null;

/* ---------- io helpers ---------- */

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function monthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json,*/*',
                 'Accept-Encoding': 'gzip, deflate' },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const enc = res.headers['content-encoding'] || '';
      let stream = res;
      if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
      else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        try {
          // These files are served with a UTF-8 BOM, which JSON.parse rejects.
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '')));
        } catch (e) { reject(e); }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function appendLines(file, lines) {
  if (!lines.length) return;
  ensureDir();
  fs.appendFileSync(path.join(DIR, file), lines.map(o => JSON.stringify(o)).join('\n') + '\n');
}

function readNdjson(file) {
  const fp = path.join(DIR, file);
  if (!fs.existsSync(fp)) return [];
  const out = [];
  for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    // A crash mid-append can leave one torn line; skip it rather than lose the file.
    try { out.push(JSON.parse(line)); } catch (_) { /* ignore */ }
  }
  return out;
}

/* ---------- parsing ---------- */

function num(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (!s || s === '-') return null;
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function cleanFuel(s) {
  // The feed leaks markup into this field, e.g. "儲能負載(Energy Storage System Load)</b>".
  return String(s || '').replace(/<[^>]*>/g, '').replace(/\(.*?\)/g, '').trim();
}

function parseUnits(raw) {
  const rows = (raw && raw.aaData) || [];
  const units = [];
  for (const r of rows) {
    const name = String(r['機組名稱'] || '').trim();
    // "小計" rows are per-fuel subtotals, and their capacity cell carries a
    // percentage in parentheses rather than a number.
    if (!name || name === '小計') continue;
    const note = String(r['備註'] || '').trim();
    const gen = num(r['淨發電量(MW)']);
    const cap = num(r['裝置容量(MW)']);
    const fuel = cleanFuel(r['機組類型']);
    units.push({
      // Name alone is not unique. Pumped storage (明潭, 大觀二, 電池) is listed
      // twice — once generating under 儲能, once pumping under 儲能負載 — and
      // 其它台電自有 appears under both 太陽能 and 風力. Keyed by name only, each
      // pair overwrites the other every poll and manufactures a transition every
      // ten minutes forever.
      key: fuel + '/' + name,
      name,
      fuel,
      cap,
      gen,
      note,
      state: note || ((gen != null && Math.abs(gen) > 0.5) ? 'running' : 'idle'),
    });
  }
  return { at: (raw && raw.DateTime) || null, units };
}

function parseSystem(raw) {
  const recs = (raw && raw.records) || [];
  const flat = Object.assign({}, ...recs.filter(r => r && typeof r === 'object'));
  return {
    load: num(flat.curr_load) != null ? num(flat.curr_load) * TENS_OF_MW_TO_MW : null,
    util: num(flat.curr_util_rate),
    foreCap: num(flat.fore_maxi_sply_capacity) != null
      ? num(flat.fore_maxi_sply_capacity) * TENS_OF_MW_TO_MW : null,
    forePeak: num(flat.fore_peak_dema_load) != null
      ? num(flat.fore_peak_dema_load) * TENS_OF_MW_TO_MW : null,
    resvCap: num(flat.fore_peak_resv_capacity) != null
      ? num(flat.fore_peak_resv_capacity) * TENS_OF_MW_TO_MW : null,
    resvRate: num(flat.fore_peak_resv_rate),
    // Taipower's own stoplight for the day: G / Y / O / R.
    indicator: (flat.fore_peak_resv_indicator || '').trim() || null,
    peakRange: (flat.fore_peak_hour_range || '').trim() || null,
    publish: (flat.publish_time || '').trim() || null,
  };
}

/* ---------- daily aggregation ---------- */

function dayKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-`
       + `${String(d.getUTCDate()).padStart(2, '0')}`;
}

function flushDay() {
  if (!today || !today.units.size) return;
  const rows = [];
  for (const [key, a] of today.units) {
    rows.push({
      d: today.day, key, name: a.name, fuel: a.fuel, cap: a.cap,
      gen: a.n ? Number((a.sum / a.n).toFixed(1)) : null,
      max: a.max, n: a.n, down: a.down,
      notes: a.notes,
    });
  }
  appendLines(`daily-${today.day.slice(0, 7)}.ndjson`, rows);
  try { fs.unlinkSync(path.join(DIR, 'daily-current.json')); } catch (_) { /* fine */ }
  today = null;
}

function accumulate(now, units) {
  const day = dayKey(now);
  if (today && today.day !== day) flushDay();
  if (!today) today = { day, units: new Map() };

  for (const u of units) {
    let a = today.units.get(u.key);
    if (!a) {
      a = { name: u.name, fuel: u.fuel, cap: u.cap, sum: 0, n: 0, max: 0, down: 0, notes: {} };
      today.units.set(u.key, a);
    }
    if (u.cap != null) a.cap = u.cap;
    if (u.gen != null) {
      a.sum += u.gen; a.n++;
      if (u.gen > a.max) a.max = Number(u.gen.toFixed(1));
    }
    if (u.state !== 'running') a.down++;
    if (u.note) a.notes[u.note] = (a.notes[u.note] || 0) + 1;
  }

  ensureDir();
  fs.writeFileSync(path.join(DIR, 'daily-current.json'),
    JSON.stringify({ day: today.day, units: [...today.units].map(([key, a]) => ({ key, ...a })) }));
}

/* ---------- retention ---------- */

function prune() {
  if (!fs.existsSync(DIR)) return;
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETAIN_MONTHS);
  const oldest = monthKey(cutoff);
  for (const f of fs.readdirSync(DIR)) {
    const m = f.match(/-(\d{4}-\d{2})\.ndjson$/);
    if (m && m[1] < oldest) {
      try { fs.unlinkSync(path.join(DIR, f)); } catch (_) { /* fine */ }
    }
  }
}

/* ---------- the poll ---------- */

async function poll() {
  const now = new Date();
  try {
    const [rawUnits, rawSys] = await Promise.all([fetchJson(UNITS_URL), fetchJson(SYS_URL)]);
    const { at, units } = parseUnits(rawUnits);
    const sys = parseSystem(rawSys);

    const mix = {};
    let genTotal = 0;
    for (const u of units) {
      if (u.gen == null) continue;
      mix[u.fuel] = Number(((mix[u.fuel] || 0) + u.gen).toFixed(1));
      genTotal += u.gen;
    }

    const t = now.toISOString();
    appendLines(`sys-${monthKey(now)}.ndjson`, [{
      t, at, load: sys.load, util: sys.util, resvRate: sys.resvRate,
      resvCap: sys.resvCap, ind: sys.indicator,
      gen: Number(genTotal.toFixed(1)), mix,
    }]);

    // Only transitions are recorded. Writing all 214 units every ten minutes would
    // be 11M rows a year to answer a question that only concerns the moments the
    // state actually changed.
    const events = [];
    for (const u of units) {
      if (lastState.get(u.key) === u.state) continue;
      events.push({ t, key: u.key, name: u.name, fuel: u.fuel, cap: u.cap,
                    gen: u.gen, state: u.state, from: lastState.get(u.key) || null });
      lastState.set(u.key, u.state);
    }
    appendLines(`events-${monthKey(now)}.ndjson`, events);

    accumulate(now, units);
    prune();

    latest = { t, at, sys, units, mix, genTotal: Number(genTotal.toFixed(1)) };
    lastError = null;
    return latest;
  } catch (e) {
    lastError = { t: now.toISOString(), message: e.message };
    throw e;
  }
}

/* ---------- boot ---------- */

function seed() {
  ensureDir();
  const now = new Date();
  // Rebuild the state map so a restart does not log a fake transition for every
  // unit, and reattach to today's partial aggregate rather than starting over.
  for (const e of readNdjson(`events-${monthKey(now)}.ndjson`))
    lastState.set(e.key || e.name, e.state);

  const fp = path.join(DIR, 'daily-current.json');
  if (fs.existsSync(fp)) {
    try {
      const saved = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (saved.day === dayKey(now)) {
        today = { day: saved.day, units: new Map(saved.units.map(u => [u.key, u])) };
      }
    } catch (_) { /* start the day fresh */ }
  }
}

let started = false;
function start() {
  if (started) return;
  started = true;
  seed();
  poll().catch(e => console.error('powerlog: first poll failed —', e.message));
  const timer = setInterval(() => poll().catch(e => console.error('powerlog:', e.message)), POLL_MS);
  if (timer.unref) timer.unref();
}

/* ---------- queries for the API ---------- */

function monthsBack(n) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(monthKey(d));
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

function history(days) {
  const since = Date.now() - days * 86400000;
  const months = monthsBack(Math.max(1, Math.ceil(days / 28) + 1));
  const rows = [];
  for (const m of months.reverse())
    for (const r of readNdjson(`sys-${m}.ndjson`))
      if (Date.parse(r.t) >= since) rows.push(r);
  rows.sort((a, b) => a.t.localeCompare(b.t));
  return rows;
}

function events(days) {
  const since = Date.now() - days * 86400000;
  const months = monthsBack(Math.max(1, Math.ceil(days / 28) + 1));
  const rows = [];
  for (const m of months.reverse())
    for (const r of readNdjson(`events-${m}.ndjson`))
      if (Date.parse(r.t) >= since) rows.push(r);
  rows.sort((a, b) => a.t.localeCompare(b.t));
  return rows;
}

function daily(days) {
  const since = Date.now() - days * 86400000;
  const months = monthsBack(Math.max(1, Math.ceil(days / 28) + 1));
  const rows = [];
  for (const m of months.reverse())
    for (const r of readNdjson(`daily-${m}.ndjson`))
      if (Date.parse(r.d + 'T00:00:00Z') >= since) rows.push(r);

  // The current day is still accumulating and only lands in a monthly file at
  // rollover. Without it, a freshly deployed recorder reports nothing at all for
  // its first day, which reads as "broken" rather than "collecting".
  if (today && today.units.size) {
    for (const [key, a] of today.units) {
      rows.push({
        d: today.day, key, name: a.name, fuel: a.fuel, cap: a.cap,
        gen: a.n ? Number((a.sum / a.n).toFixed(1)) : null,
        max: a.max, n: a.n, down: a.down, notes: a.notes, partial: true,
      });
    }
  }
  return rows;
}

// The payoff view: what only a tape can answer.
function findings(days) {
  const evs = events(days);
  const rows = daily(days);

  const byUnit = new Map();
  for (const r of rows) {
    const k = r.key || r.name;
    let u = byUnit.get(k);
    if (!u) { u = { name: r.name, fuel: r.fuel, cap: r.cap, samples: 0, down: 0,
                    genSum: 0, genN: 0, notes: {} }; byUnit.set(k, u); }
    u.samples += r.n || 0;
    u.down += r.down || 0;
    if (r.gen != null && r.n) { u.genSum += r.gen * r.n; u.genN += r.n; }
    for (const [k, v] of Object.entries(r.notes || {})) u.notes[k] = (u.notes[k] || 0) + v;
    if (r.cap != null) u.cap = r.cap;
  }

  const units = [...byUnit.values()].map(u => ({
    name: u.name, fuel: u.fuel, cap: u.cap,
    downPct: u.samples ? Number((u.down / u.samples * 100).toFixed(1)) : null,
    capFactor: (u.genN && u.cap) ? Number((u.genSum / u.genN / u.cap * 100).toFixed(1)) : null,
    notes: u.notes,
  }));

  const noteTotals = {};
  for (const u of units)
    for (const [k, v] of Object.entries(u.notes)) noteTotals[k] = (noteTotals[k] || 0) + v;

  return {
    days,
    coverage: rows.length ? { from: rows[0].d, to: rows[rows.length - 1].d,
                              unitDays: rows.length } : null,
    transitions: evs.length,
    noteTotals,
    mostDown: units.filter(u => u.downPct != null)
                   .sort((a, b) => b.downPct - a.downPct).slice(0, 15),
    lowestCapFactor: units.filter(u => u.capFactor != null && u.cap >= 100)
                          .sort((a, b) => a.capFactor - b.capFactor).slice(0, 15),
    recentEvents: evs.slice(-60).reverse(),
  };
}

function status() {
  let files = [];
  try { files = fs.readdirSync(DIR); } catch (_) { /* not created yet */ }
  return {
    latest: latest ? { t: latest.t, at: latest.at } : null,
    lastError,
    tracked: lastState.size,
    files: files.length,
    dataDir: DIR,
  };
}

module.exports = { start, poll, history, events, daily, findings, status,
                   get latest() { return latest; } };
