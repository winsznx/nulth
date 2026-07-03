// Headless check of the Create screen's CLIENT-SIDE policy computation (the Freighter-independent
// part): the browser computes a real Poseidon commitment + DEPTH-16 root from form inputs, with no
// server. Also confirms globals load and the demo dashboard still reads live (Task E spot-check).
// (The Freighter connect + deploy signing cannot run headless — proven instead by create_user.mjs.)
import http from 'http'; import fs from 'fs'; import path from 'path'; import { spawn } from 'child_process';
const ROOT='/Users/mac/covenant/web', OUT='/Users/mac/covenant/web/.shots', PORT=8137;
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME={'.html':'text/html','.js':'text/javascript','.json':'application/json','.wasm':'application/wasm'};
fs.mkdirSync(OUT,{recursive:true});
const server=http.createServer((q,s)=>{ let f=path.join(ROOT,q.url==='/'?'index.html':decodeURIComponent(q.url.split('?')[0])); fs.readFile(f,(e,d)=>{ if(e){s.writeHead(404);s.end('nf');return;} s.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream'}); s.end(d); }); });
await new Promise(r=>server.listen(PORT,r));
const ud='/tmp/covcreate_'+process.pid;
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--disable-dev-shm-usage',`--user-data-dir=${ud}`,'--remote-debugging-port=9401','--window-size=1320,900','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wsu(){ for(let i=0;i<60;i++){ try{ const l=await (await fetch('http://localhost:9401/json/list')).json(); const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl); if(p)return p.webSocketDebuggerUrl;}catch{} await sleep(200);} throw 'no cdp'; }
const ws=new WebSocket(await wsu()); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0; const pend=new Map(); const errs=[];
ws.onmessage=m=>{ const o=JSON.parse(m.data); if(o.id&&pend.has(o.id)){pend.get(o.id)(o);pend.delete(o.id);} if(o.method==='Runtime.consoleAPICalled'&&o.params.type==='error') errs.push((o.params.args||[]).map(a=>a.value||a.description).join(' ')); if(o.method==='Runtime.exceptionThrown') errs.push('EXC: '+(o.params.exceptionDetails.exception?.description||o.params.exceptionDetails.text)); };
const cmd=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async(e,aw)=>{ const r=await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:!!aw}); if(r.result&&r.result.exceptionDetails) return {__exc:String(r.result.exceptionDetails.exception&&r.result.exceptionDetails.exception.description||r.result.exceptionDetails.text)}; return r.result&&r.result.result?r.result.result.value:undefined; };
const snap=async n=>{ const r=await cmd('Page.captureScreenshot',{format:'png'}); if(r.result&&r.result.data){fs.writeFileSync(path.join(OUT,n),Buffer.from(r.result.data,'base64'));console.log('shot',n);} };
await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Page.navigate',{url:`http://localhost:${PORT}/`}); await sleep(1500);

console.log('=== globals (create-flow libs loaded) ===');
console.log(await ev('JSON.stringify({poseidon:typeof window.CovenantPoseidon,wallet:typeof window.CovenantWallet,create:typeof window.CovenantCreate,chain:typeof window.CovenantChain,setActive:typeof (window.CovenantChain&&CovenantChain.setActive),freighterAvail:window.CovenantWallet&&CovenantWallet.available()})'));

console.log('=== wait for demo live reads (Task E spot-check) ===');
for(let i=0;i<30;i++){ if(await ev('App.live.loading')===false) break; await sleep(700); }
console.log(await ev('JSON.stringify({demoAccount:App.acct(),isDemo:App.isDemoAcct(),balance:String(App.live.balance),policyCommit:App.live.policy&&App.live.policy.commitment?App.live.policy.commitment.slice(0,12):null})'));

console.log('=== Create screen: CLIENT-SIDE policy computation (no wallet, no server) ===');
await ev("App.nav('create')"); await sleep(400);
await ev("App.setCap('25')");
await ev("App.setAllow(0,'GBEOVHEZI2PS6OMLKZFULUXFSG5ZN3YAKUJE7UV3B7ACJVIXDA2UU4BS')");
const pol=await ev('App.previewPolicy().then(p=>JSON.stringify({commitment:p.commitment,root:p.root,members:p.members.length,m0:p.members[0]&&{idx:p.members[0].index,pathLen:p.members[0].path.length}}))', true);
console.log('client-side policy:', pol);
// in-browser internal consistency: the member path reproduces the root (circuit-equivalence)
const consistent=await ev("(function(){var p=App.create.policy;var m=p.members[0];return window.CovenantPoseidon.verifyMember(p.root,m.destLeaf,m.path,m.index_bits);})()");
console.log('in-browser verifyMember (path -> root):', consistent);
await snap('create-screen.png');
console.log('console errors:', errs.length?errs.slice(0,6).join(' | '):'NONE');
ws.close(); chrome.kill('SIGKILL'); server.close(); try{fs.rmSync(ud,{recursive:true,force:true});}catch{} process.exit(0);
