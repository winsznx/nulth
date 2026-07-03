// Drive headless Chrome to run the REAL in-browser DEPTH-16 prover and read back
// the client-side proving time + JS heap via the DevTools Protocol (no puppeteer).
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const ROOT = '/Users/mac/covenant/web/prover';
const PORT = 8765;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.zkey': 'application/octet-stream' };

const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : req.url.slice(1));
  fs.readFile(f, (e, data) => {
    if (e) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(PORT, r));

const userDir = '/tmp/covchrome_' + process.pid;
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  '--disable-dev-shm-usage', `--user-data-dir=${userDir}`, '--remote-debugging-port=9222',
  `http://localhost:${PORT}/index.html`,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getWsUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch('http://localhost:9222/json/list')).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('no CDP target');
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const o = JSON.parse(m.data); if (o.id && pending.has(o.id)) { pending.get(o.id)(o); pending.delete(o.id); } };
const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await cmd('Runtime.enable');
await cmd('Performance.enable');
const evalExpr = `new Promise((res)=>{const i=setInterval(()=>{if(window.__COVENANT_RESULT__){clearInterval(i);res(window.__COVENANT_RESULT__)}},200);setTimeout(()=>{clearInterval(i);res(window.__COVENANT_RESULT__||{timeout:true})},180000)})`;
const evalRes = await cmd('Runtime.evaluate', { expression: evalExpr, awaitPromise: true, returnByValue: true });
const result = evalRes.result?.result?.value ?? evalRes.result?.value;
const metrics = await cmd('Performance.getMetrics');
const heap = (metrics.result?.metrics || []).find((m) => m.name === 'JSHeapUsedSize');

console.log('BROWSER_RESULT=' + JSON.stringify(result));
if (heap) console.log('CDP_JSHeapUsedSize_MB=' + Math.round(heap.value / 1048576));
console.log('CHROME_VERSION=' + (await (await fetch('http://localhost:9222/json/version')).json()).Browser);

ws.close();
chrome.kill('SIGKILL');
server.close();
try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
process.exit(0);
