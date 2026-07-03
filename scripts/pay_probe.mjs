// Reproduce the pay failure on the live deploy and capture the exact relayer error.
// Wraps window.fetch to log every /api/ request + response body, then runs the agent pay
// and the manual pay, dumping the full error state of each.
import { spawn } from 'child_process';
import fs from 'fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.TARGET_URL || 'https://nulth-production.up.railway.app/';
const PORT = 9477;
const ud = '/private/tmp/nulth_pay_' + process.pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-sandbox','--window-size=1440,900',
  `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });
async function wsu(){ for(let i=0;i<60;i++){ try{ const l=await (await fetch(`http://localhost:${PORT}/json/list`)).json(); const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl); if(p)return p.webSocketDebuggerUrl;}catch{} await sleep(200);} throw 'no cdp'; }
await sleep(1500);
const ws = new WebSocket(await wsu()); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0; const pend=new Map();
ws.onmessage=m=>{const o=JSON.parse(m.data);if(o.id&&pend.has(o.id)){pend.get(o.id)(o);pend.delete(o.id);}};
const cmd=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async(e,aw)=>{const r=await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:!!aw}); if(r.result&&r.result.exceptionDetails)return{__err:r.result.exceptionDetails.text}; return r.result&&r.result.result?r.result.result.value:undefined;};

await cmd('Runtime.enable'); await cmd('Page.enable');
// install a fetch wrapper BEFORE app scripts run
await cmd('Page.addScriptToEvaluateOnNewDocument',{source:`
  window.__api=[];
  const _f=window.fetch;
  window.fetch=async function(u,opt){ const url=(typeof u==='string'?u:(u&&u.url))||'';
    let r; try{ r=await _f.apply(this,arguments);}catch(e){ if(/\\/api\\//.test(url)) window.__api.push({url, err:String(e)}); throw e; }
    if(/\\/api\\//.test(url)){ try{ const c=r.clone(); const t=await c.text(); window.__api.push({url, status:r.status, body:t.slice(0,500)});}catch(e){} }
    return r; };
`});
await cmd('Page.navigate',{url:URL}); await sleep(2500);
for(let i=0;i<30;i++){ if(await ev('window.App && App.live && App.live.loading')===false) break; await sleep(700); }
await sleep(1200);

const out={ url:URL };
out.demoPayee = await ev('window.COVENANT && COVENANT.demoPayee');
out.chainDump = JSON.parse(await ev(`JSON.stringify({hasRelayer:!!(CovenantChain&&CovenantChain.hasRelayer), relay:(CovenantChain._relay||null), balance:String(App.live.balance)})`)||'{}');

// ---- AGENT PAY ----
await ev(`App.nav('agent')`); await sleep(500);
await ev(`App.sendAgent('pay a vendor 1 USDC')`);
for(let i=0;i<30;i++){ const b=await ev('App.agent.busy'); if(b===false && i>1) break; await sleep(1500); }
out.agentThreadFull = JSON.parse(await ev(`JSON.stringify(App.agent.thread)`)||'[]');

// ---- MANUAL PAY ----
await ev(`App.nav('pay')`); await sleep(500);
await ev(`App.state.payDest=COVENANT.demoPayee; App.state.payAmount='1';`);
await ev(`App.runPay()`);
for(let i=0;i<30;i++){ const ph=await ev('App.pay && App.pay.phase'); if(ph!=='running'&&ph!=='proving'&&i>1) break; await sleep(1500); }
out.payState = JSON.parse(await ev(`JSON.stringify({phase:App.pay.phase, step:App.pay.step, error:App.pay.error||null, refusedReason:App.pay.refusedReason||null})`)||'{}');

// ---- API CALLS captured ----
out.apiCalls = JSON.parse(await ev(`JSON.stringify(window.__api||[])`)||'[]');

console.log('=== PAY PROBE ===');
console.log(JSON.stringify(out,null,2));
ws.close(); chrome.kill('SIGKILL'); try{fs.rmSync(ud,{recursive:true,force:true});}catch{}
await sleep(200); process.exit(0);
