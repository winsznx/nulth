// Headless e2e for the Exploitation Deck: fire each live attack via the browser, confirm a real
// FAILED on-chain tx + the precise __check_auth code. Real testnet, no mocks.
import http from 'http'; import fs from 'fs'; import path from 'path'; import { spawn } from 'child_process';
const ROOT='/Users/mac/covenant/web', OUT='/Users/mac/covenant/web/.shots', PORT=8133;
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME={'.html':'text/html','.js':'text/javascript','.json':'application/json','.wasm':'application/wasm'};
fs.mkdirSync(OUT,{recursive:true});
const server=http.createServer((q,s)=>{ let f=path.join(ROOT,q.url==='/'?'index.html':decodeURIComponent(q.url.split('?')[0])); fs.readFile(f,(e,d)=>{ if(e){s.writeHead(404);s.end('nf');return;} s.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream'}); s.end(d); }); });
await new Promise(r=>server.listen(PORT,r));
const ud='/tmp/covdeck_'+process.pid;
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--disable-dev-shm-usage',`--user-data-dir=${ud}`,'--remote-debugging-port=9377','--window-size=1320,900','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wsu(){ for(let i=0;i<60;i++){ try{ const l=await (await fetch('http://localhost:9377/json/list')).json(); const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl); if(p)return p.webSocketDebuggerUrl;}catch{} await sleep(200);} throw 'no cdp'; }
const ws=new WebSocket(await wsu()); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0; const pend=new Map(); const errs=[];
ws.onmessage=m=>{ const o=JSON.parse(m.data); if(o.id&&pend.has(o.id)){pend.get(o.id)(o);pend.delete(o.id);} if(o.method==='Runtime.exceptionThrown') errs.push(o.params.exceptionDetails.exception?.description||o.params.exceptionDetails.text); };
const cmd=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async(e)=>{ const r=await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}); return r.result&&r.result.result?r.result.result.value:undefined; };
const snap=async n=>{ const r=await cmd('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:1280,height:1400,scale:1},captureBeyondViewport:true}); if(r.result&&r.result.data){fs.writeFileSync(path.join(OUT,n),Buffer.from(r.result.data,'base64'));console.log('shot',n);} };
await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
await cmd('Page.navigate',{url:`http://localhost:${PORT}/`}); await sleep(1500);
for(let i=0;i<30;i++){ if(await ev('App.live.loading')===false) break; await sleep(700); }
await ev("App.nav('breaking')"); await sleep(400);
const modes=['malleability','wrongtoken','redirect','oldpolicy','noncelift'];
for(const m of modes){
  console.log('--- firing',m,'---');
  await ev(`App.runAttack('${m}')`);
  for(let i=0;i<40;i++){ const st=await ev(`(App.state.deck['${m}']||{}).status`); if(st==='rejected'||st==='error'){break;} await sleep(1500); }
  console.log(await ev(`JSON.stringify(App.state.deck['${m}'])`));
}
await snap('deck-live.png');
console.log('console errors:', errs.length?errs.slice(0,6).join(' | '):'NONE');
ws.close(); chrome.kill('SIGKILL'); server.close(); try{fs.rmSync(ud,{recursive:true,force:true});}catch{} process.exit(0);
