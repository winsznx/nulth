// Headless end-to-end check of the live web foundation:
// globals/console-errors, live reads, a REAL proof-authorized payment, out-of-policy refusal.
import http from 'http'; import fs from 'fs'; import path from 'path'; import { spawn } from 'child_process';
const ROOT='/Users/mac/covenant/web', OUT='/Users/mac/covenant/web/.shots', PORT=8131;
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME={'.html':'text/html','.js':'text/javascript','.json':'application/json','.wasm':'application/wasm'};
fs.mkdirSync(OUT,{recursive:true});
const server=http.createServer((q,s)=>{ let f=path.join(ROOT,q.url==='/'?'index.html':decodeURIComponent(q.url.split('?')[0])); fs.readFile(f,(e,d)=>{ if(e){s.writeHead(404);s.end('nf');return;} s.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream'}); s.end(d); }); });
await new Promise(r=>server.listen(PORT,r));
const ud='/tmp/cove2e_'+process.pid;
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--disable-dev-shm-usage',`--user-data-dir=${ud}`,'--remote-debugging-port=9355','--window-size=1320,900','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wsu(){ for(let i=0;i<60;i++){ try{ const l=await (await fetch('http://localhost:9355/json/list')).json(); const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl); if(p)return p.webSocketDebuggerUrl;}catch{} await sleep(200);} throw 'no cdp'; }
const ws=new WebSocket(await wsu()); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0; const pend=new Map(); const logs=[]; const errs=[];
ws.onmessage=m=>{ const o=JSON.parse(m.data);
  if(o.id&&pend.has(o.id)){pend.get(o.id)(o);pend.delete(o.id);}
  if(o.method==='Runtime.consoleAPICalled'){ const t=o.params.type; const txt=(o.params.args||[]).map(a=>a.value!==undefined?a.value:a.description).join(' '); if(t==='error') errs.push(txt); logs.push(t+': '+txt); }
  if(o.method==='Runtime.exceptionThrown'){ errs.push('EXC: '+(o.params.exceptionDetails.exception?.description||o.params.exceptionDetails.text)); }
};
const cmd=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async(expr,awaitP)=>{ const r=await cmd('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:!!awaitP}); if(r.result&&r.result.exceptionDetails) return {__exc:r.result.exceptionDetails.text}; return r.result&&r.result.result?r.result.result.value:undefined; };
const snap=async n=>{ const r=await cmd('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:1280,height:900,scale:1}}); if(r.result&&r.result.data){fs.writeFileSync(path.join(OUT,n),Buffer.from(r.result.data,'base64'));console.log('shot',n);} };
await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Emulation.setDeviceMetricsOverride',{width:1280,height:860,deviceScaleFactor:1,mobile:false});
await cmd('Page.navigate',{url:`http://localhost:${PORT}/`}); await sleep(1500);

console.log('=== globals ===');
console.log(await ev('JSON.stringify({Buffer:typeof window.Buffer,SDK:typeof window.StellarSdk,rpc:typeof (window.StellarSdk&&StellarSdk.rpc),snarkjs:typeof window.snarkjs,ser:typeof window.CovenantSerialize,chain:typeof window.CovenantChain,prover:typeof window.CovenantProver,opKey:window.CovenantChain&&CovenantChain.hasOperatorKey()})'));

console.log('=== wait for live reads ===');
for(let i=0;i<30;i++){ const loading=await ev('App.live.loading'); if(loading===false) break; await sleep(700); }
console.log(await ev('JSON.stringify({loading:App.live.loading,balance:String(App.live.balance),payee:String(App.live.payeeBalance),policyCommit:App.live.policy&&App.live.policy.commitment?App.live.policy.commitment.slice(0,14):null,token:App.live.policy&&App.live.policy.token,secretCap:App.live.secret&&App.live.secret.cap})'));
await ev("App.nav('dashboard')"); await sleep(600); await snap('e2e-dashboard.png');

console.log('=== wording checks (landing) ===');
await ev("App.nav('landing')"); await sleep(500);
console.log(await ev('JSON.stringify({noSpendingKey:document.body.innerText.includes("no spending key"),oneSentence:document.body.innerText.includes("rules the chain has never seen"),cost8537:document.body.innerText.includes("8.537"),slots:document.body.innerText.includes("65,536"),badPriv:document.body.innerText.toLowerCase().includes("no private key"),bad7903:document.body.innerText.includes("7.903")})'));
await ev("App.nav('dashboard')"); await sleep(300);

console.log('=== VALID payment (browser proof -> chain) ===');
await ev("App.nav('pay')"); await sleep(500);
await ev("(function(){document.getElementById('pay-amount').value='1';document.getElementById('pay-dest').value=window.COVENANT.demoPayee;return true;})()");
await ev('App.runPay()'); // fire (don't await; poll phase)
for(let i=0;i<45;i++){ const ph=await ev('App.pay.phase'); if(ph==='done'||ph==='refused'||ph==='error'){console.log('phase:',ph);break;} await sleep(1500); }
console.log(await ev('JSON.stringify({phase:App.pay.phase,hash:App.pay.result&&App.pay.result.hash,status:App.pay.result&&App.pay.result.status,proveMs:App.pay.result&&App.pay.result.proveMs,instr:App.pay.result&&App.pay.result.declaredInstr,beforeAcc:App.pay.before&&String(App.pay.before.acc),afterAcc:App.pay.after&&String(App.pay.after.acc),beforePayee:App.pay.before&&String(App.pay.before.payee),afterPayee:App.pay.after&&String(App.pay.after.payee),err:App.pay.error})'));
await snap('e2e-pay-success.png');

console.log('=== OUT-OF-POLICY refusal (no tx) ===');
await ev("App.dispatch('payreset')"); await sleep(300);
await ev("App.nav('pay')"); await sleep(400);
await ev("(function(){document.getElementById('pay-amount').value='1';document.getElementById('pay-dest').value=window.COVENANT.demoNonAllowlisted;return true;})()");
await ev('App.runPay()');
for(let i=0;i<20;i++){ const ph=await ev('App.pay.phase'); if(ph==='refused'||ph==='error'||ph==='done'){console.log('phase:',ph);break;} await sleep(1000); }
console.log(await ev('JSON.stringify({phase:App.pay.phase,reason:App.pay.refusedReason,err:App.pay.error})'));
await snap('e2e-pay-refused.png');

console.log('=== console errors ===');
console.log(errs.length?errs.slice(0,12).join('\n'):'NONE');
ws.close(); chrome.kill('SIGKILL'); server.close(); try{fs.rmSync(ud,{recursive:true,force:true});}catch{} process.exit(0);
