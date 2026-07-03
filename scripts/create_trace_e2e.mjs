// PRIVACY PROOF: build a policy in the real browser with a UNIQUE allowlist address and capture
// EVERY outbound network request. Assert the allowlist address appears in ZERO request URLs/bodies
// — i.e. building the policy + DEPTH-16 tree makes no network call carrying an allowlist address.
import http from 'http'; import fs from 'fs'; import path from 'path'; import { spawn } from 'child_process';
const ROOT='/Users/mac/covenant/web', PORT=8145; const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME={'.html':'text/html','.js':'text/javascript','.json':'application/json','.wasm':'application/wasm'};
const server=http.createServer((q,s)=>{let f=path.join(ROOT,q.url==='/'?'index.html':decodeURIComponent(q.url.split('?')[0]));fs.readFile(f,(e,d)=>{if(e){s.writeHead(404);s.end('nf');return;}s.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream'});s.end(d);});});
await new Promise(r=>server.listen(PORT,r));
const ud='/tmp/covtrace_'+process.pid; const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox',`--user-data-dir=${ud}`,'--remote-debugging-port=9417','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wsu(){for(let i=0;i<60;i++){try{const l=await (await fetch('http://localhost:9417/json/list')).json();const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl;}catch{}await sleep(200);}throw'no cdp';}
const ws=new WebSocket(await wsu());await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0;const pend=new Map();const reqs=[];const errs=[];
ws.onmessage=m=>{const o=JSON.parse(m.data);
  if(o.id&&pend.has(o.id)){pend.get(o.id)(o);pend.delete(o.id);}
  if(o.method==='Network.requestWillBeSent'){ const r=o.params.request; reqs.push({url:r.url, body:r.postData||''}); }
  if(o.method==='Runtime.consoleAPICalled'&&o.params.type==='error') errs.push((o.params.args||[]).map(a=>a.value||a.description).join(' '));
  if(o.method==='Runtime.exceptionThrown') errs.push('EXC '+(o.params.exceptionDetails.exception?.description||o.params.exceptionDetails.text));
};
const cmd=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async(e,aw)=>{const r=await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:!!aw});if(r.result&&r.result.exceptionDetails)return{__exc:r.result.exceptionDetails.text};return r.result&&r.result.result?r.result.result.value:undefined;};
await cmd('Network.enable');await cmd('Runtime.enable');await cmd('Page.enable');
await cmd('Page.navigate',{url:`http://localhost:${PORT}/`});await sleep(1800);
for(let i=0;i<25;i++){if(await ev('App.live.loading')===false)break;await sleep(600);}

// a UNIQUE allowlist address the app never otherwise queries
const ADDR = await ev('window.__A = StellarSdk.Keypair.random().publicKey(); window.__A');
console.log('unique allowlist address:', ADDR);
await ev("App.nav('create')"); await sleep(300);
reqs.length = 0; // only count requests from here (the policy-build window)
// drive the form + build the policy fully client-side (no wallet)
const pol = await ev(`(async()=>{ App.create.cap='40'; App.create.allowlist=[window.__A]; const p=await App.previewPolicy(); return JSON.stringify({commitment:p.commitment.slice(0,16), root:p.root.slice(0,16), members:p.members.length}); })()`, true);
await sleep(400);
console.log('policy built client-side:', pol);
const leaks = reqs.filter(r => (r.url+ ' ' + r.body).includes(ADDR));
console.log('requests during policy build:', reqs.length);
console.log('requests containing the allowlist address:', leaks.length, leaks.length?JSON.stringify(leaks.slice(0,3)):'(none)');
console.log('RESULT:', leaks.length===0 ? 'PASS — no allowlist address left the browser' : 'FAIL — address leaked');
console.log('console errors:', errs.length?errs.slice(0,4).join(' | '):'NONE');
ws.close();chrome.kill('SIGKILL');server.close();try{fs.rmSync(ud,{recursive:true,force:true});}catch{}process.exit(leaks.length===0?0:1);
