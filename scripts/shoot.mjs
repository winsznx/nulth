// Screenshot each Covenant SPA screen in headless Chrome (CDP, no puppeteer) to verify render.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const ROOT = '/Users/mac/covenant/web';
const OUT = '/Users/mac/covenant/web/.shots';
const PORT = 8123;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.wasm':'application/wasm' };
fs.mkdirSync(OUT, { recursive: true });

const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if(req.url === '/' ) f = path.join(ROOT, 'index.html');
  fs.readFile(f, (e, data) => {
    if(e){ res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise(r => server.listen(PORT, r));

const userDir = '/tmp/covshot_' + process.pid;
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--disable-dev-shm-usage',
  `--user-data-dir=${userDir}`,'--remote-debugging-port=9333','--window-size=1320,900','about:blank'], { stdio:'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function wsUrl(){
  for(let i=0;i<50;i++){ try{ const l = await (await fetch('http://localhost:9333/json/list')).json(); const p = l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl); if(p) return p.webSocketDebuggerUrl; }catch{} await sleep(200); }
  throw new Error('no CDP');
}
const url = await wsUrl();
const ws = new WebSocket(url);
await new Promise((r,j)=>{ ws.onopen=r; ws.onerror=j; });
let id=0; const pend=new Map();
ws.onmessage=(m)=>{ const o=JSON.parse(m.data); if(o.id&&pend.has(o.id)){ pend.get(o.id)(o); pend.delete(o.id); } };
const cmd=(method,params={})=>new Promise(r=>{ const i=++id; pend.set(i,r); ws.send(JSON.stringify({id:i,method,params})); });

await cmd('Page.enable');
await cmd('Runtime.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width:1280, height:860, deviceScaleFactor:1, mobile:false });
await cmd('Page.navigate', { url:`http://localhost:${PORT}/` });
await sleep(1200);

const screens = ['landing','dashboard','policy','agent','breaking','verify','activity','compare'];
const errors = [];
const probe = await cmd('Runtime.evaluate', { expression:'(typeof App!=="undefined")+"|"+(document.getElementById("root").children.length)', returnByValue:true });
console.log('App present | root children:', probe.result?.result?.value);

for(const s of screens){
  await cmd('Runtime.evaluate', { expression:`App.nav('${s}')` });
  await sleep(500);
  const shot = await cmd('Page.captureScreenshot', { format:'png', captureBeyondViewport:true, clip:{ x:0, y:0, width:1280, height:900, scale:1 } });
  const data = shot.result?.data;
  if(data){ fs.writeFileSync(path.join(OUT, s+'.png'), Buffer.from(data,'base64')); console.log('shot', s, '->', s+'.png'); }
  else { errors.push(s); console.log('NO SHOT for', s); }
}
const logs = await cmd('Runtime.evaluate', { expression:'window.__err||"none"', returnByValue:true });
console.log('done. errors:', errors.length?errors.join(','):'none');

ws.close(); chrome.kill('SIGKILL'); server.close();
try{ fs.rmSync(userDir,{recursive:true,force:true}); }catch{}
process.exit(0);
