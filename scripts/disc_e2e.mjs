// Headless e2e for the Tier-1 disclosure flow: prove cap<=limit in-browser, verify on-chain.
import http from 'http'; import fs from 'fs'; import path from 'path'; import { spawn } from 'child_process';
const ROOT='/Users/mac/covenant/web', OUT='/Users/mac/covenant/web/.shots', PORT=8132;
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME={'.html':'text/html','.js':'text/javascript','.json':'application/json','.wasm':'application/wasm'};
fs.mkdirSync(OUT,{recursive:true});
const server=http.createServer((q,s)=>{ let f=path.join(ROOT,q.url==='/'?'index.html':decodeURIComponent(q.url.split('?')[0])); fs.readFile(f,(e,d)=>{ if(e){s.writeHead(404);s.end('nf');return;} s.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream'}); s.end(d); }); });
await new Promise(r=>server.listen(PORT,r));
const ud='/tmp/covdisc_'+process.pid;
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--disable-dev-shm-usage',`--user-data-dir=${ud}`,'--remote-debugging-port=9366','--window-size=1320,900','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wsu(){ for(let i=0;i<60;i++){ try{ const l=await (await fetch('http://localhost:9366/json/list')).json(); const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl); if(p)return p.webSocketDebuggerUrl;}catch{} await sleep(200);} throw 'no cdp'; }
const ws=new WebSocket(await wsu()); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0; const pend=new Map(); const errs=[];
ws.onmessage=m=>{ const o=JSON.parse(m.data); if(o.id&&pend.has(o.id)){pend.get(o.id)(o);pend.delete(o.id);} if(o.method==='Runtime.exceptionThrown') errs.push(o.params.exceptionDetails.exception?.description||o.params.exceptionDetails.text); if(o.method==='Runtime.consoleAPICalled'&&o.params.type==='error') errs.push((o.params.args||[]).map(a=>a.value||a.description).join(' ')); };
const cmd=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async(e)=>{ const r=await cmd('Runtime.evaluate',{expression:e,returnByValue:true}); return r.result&&r.result.result?r.result.result.value:undefined; };
const snap=async n=>{ const r=await cmd('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:1280,height:900,scale:1}}); if(r.result&&r.result.data){fs.writeFileSync(path.join(OUT,n),Buffer.from(r.result.data,'base64'));console.log('shot',n);} };
await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Emulation.setDeviceMetricsOverride',{width:1280,height:860,deviceScaleFactor:1,mobile:false});
await cmd('Page.navigate',{url:`http://localhost:${PORT}/`}); await sleep(1500);
for(let i=0;i<30;i++){ if(await ev('App.live.loading')===false) break; await sleep(700); }
console.log('hidden cap (USDC):', await ev('App.live.secret? Number(App.live.secret.cap)/1e7 : null'), '| on-chain commitment:', await ev('App.live.policy?App.live.policy.commitment.slice(0,14):null'));

await ev("App.nav('verify')"); await sleep(400);
console.log('=== compliant: limit 500 USDC >= cap 100 ===');
await ev("(function(){App.disc.limit=500;App.runDisclosure();return true;})()");
for(let i=0;i<40;i++){ const ph=await ev('App.disc.phase'); if(ph==='verified'||ph==='cannotprove'||ph==='error'){console.log('phase:',ph);break;} await sleep(800); }
console.log(await ev('JSON.stringify({phase:App.disc.phase,ms:App.disc.result&&App.disc.result.ms,insns:App.disc.result&&App.disc.result.insns,commit:App.disc.result&&App.disc.result.commitment?App.disc.result.commitment.slice(0,14):null,err:App.disc.error})'));
await snap('disc-verified.png');

console.log('=== non-compliant: limit 50 USDC < cap 100 ===');
await ev("(function(){App.disc.limit=50;App.runDisclosure();return true;})()");
for(let i=0;i<30;i++){ const ph=await ev('App.disc.phase'); if(ph==='cannotprove'||ph==='error'||ph==='verified'){console.log('phase:',ph);break;} await sleep(700); }
console.log(await ev('JSON.stringify({phase:App.disc.phase,err:App.disc.error})'));
await snap('disc-cannotprove.png');

console.log('console errors:', errs.length?errs.slice(0,8).join(' | '):'NONE');
ws.close(); chrome.kill('SIGKILL'); server.close(); try{fs.rmSync(ud,{recursive:true,force:true});}catch{} process.exit(0);
