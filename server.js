const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DATA_DIR = '/data';
const APP_DIR = '/app';
const DATA_FILE = path.join(DATA_DIR, 'invest-data.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

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
