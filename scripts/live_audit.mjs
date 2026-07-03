// Functional audit of the deployed Nulth site via headless Chrome + CDP.
// Captures console errors, uncaught exceptions, and failed network requests (4xx/5xx/blocked)
// globally and per in-app view, plus the state of chain reads and the agent flow.
// Usage: TARGET_URL=https://nulth-production.up.railway.app/ node scripts/live_audit.mjs
import { spawn } from 'child_process';
import fs from 'fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.TARGET_URL || 'https://nulth-production.up.railway.app/';
const PORT = 9466;
const ud = '/private/tmp/nulth_audit_' + process.pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-sandbox','--window-size=1440,900',
  `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });

async function wsu(){ for(let i=0;i<60;i++){ try{ const l=await (await fetch(`http://localhost:${PORT}/json/list`)).json(); const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl); if(p)return p.webSocketDebuggerUrl;}catch{} await sleep(200);} throw 'no cdp'; }

await sleep(1500);
const ws = new WebSocket(await wsu()); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0; const pend=new Map();
const errs=[];        // console error / exception strings
const netfail=[];     // {url, status|errorText, type}
const reqType=new Map();
ws.onmessage=m=>{ const o=JSON.parse(m.data);
  if(o.id&&pend.has(o.id)){pend.get(o.id)(o);pend.delete(o.id);}
  const p=o.params||{};
  if(o.method==='Runtime.consoleAPICalled'&&p.type==='error') errs.push((p.args||[]).map(a=>a.value||a.description||JSON.stringify(a.preview||'')).join(' ').slice(0,300));
  if(o.method==='Runtime.exceptionThrown') errs.push('EXC '+((p.exceptionDetails&&(p.exceptionDetails.exception?.description||p.exceptionDetails.text))||'').slice(0,300));
  if(o.method==='Network.requestWillBeSent') reqType.set(p.requestId, p.request&&p.request.url);
  if(o.method==='Network.responseReceived'){ const s=p.response&&p.response.status; if(s>=400) netfail.push({url:(p.response.url||'').slice(0,160), status:s}); }
  if(o.method==='Network.loadingFailed'){ const u=reqType.get(p.requestId)||''; if(!/favicon/.test(u)&&!p.canceled) netfail.push({url:u.slice(0,160), errorText:p.errorText, blocked:p.blockedReason||null}); }
};
const cmd=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async(e,aw)=>{const r=await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:!!aw}); if(r.result&&r.result.exceptionDetails)return{__err:(r.result.exceptionDetails.text||'')}; return r.result&&r.result.result?r.result.result.value:undefined;};

await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Network.enable');
await cmd('Page.navigate',{url:URL}); await sleep(2500);
for(let i=0;i<30;i++){ if(await ev('window.App && App.live && App.live.loading')===false) break; await sleep(700); }
await sleep(1500);

const out={ url:URL, load:{}, views:{}, chain:{}, agent:{}, health:null };
out.load.errsAfterLoad = errs.slice();
out.load.netfailAfterLoad = netfail.slice();

out.health = await ev("fetch('/api/health').then(r=>r.json()).then(j=>JSON.stringify(j)).catch(e=>'ERR '+e)", true);

// chain read state
out.chain = JSON.parse(await ev(`JSON.stringify({
  loading:App.live.loading, netError:App.live.netError, error:App.live.error||null,
  hasSecret:!!App.live.secret, hasPolicy:!!App.live.policy,
  balance:(App.live.balance!==undefined?String(App.live.balance):null),
  activityN:(App.live.activity&&App.live.activity.length)||0,
  hasRelayer:!!(window.CovenantChain&&CovenantChain.hasRelayer),
  hasOperatorKey:!!(window.CovenantChain&&CovenantChain.hasOperatorKey&&CovenantChain.hasOperatorKey()),
  hasAdminKey:!!(window.CovenantChain&&CovenantChain.hasAdminKey&&CovenantChain.hasAdminKey())
})`) || '{}');

// per-view sweep
const views=['dashboard','pay','activity','policy','compare','agent','breaking','verify','account','create'];
for(const view of views){
  const before=errs.length, beforeNet=netfail.length;
  await ev(`App.nav('${view}')`); await sleep(1200);
  const txt = await ev(`(document.getElementById('cv-main')||document.body).innerText`);
  const placeholders = (txt||'').match(/reading…|loading…|—\s|failed|error|couldn't|can't reach|undefined|NaN/gi);
  out.views[view] = {
    newErrs: errs.slice(before),
    newNetFail: netfail.slice(beforeNet),
    placeholderHits: placeholders ? [...new Set(placeholders.map(s=>s.trim()))].slice(0,8) : [],
    textLen: (txt||'').length
  };
}

// agent flow (groq or fallback): send an instruction, watch it try to pay
await ev(`App.nav('agent')`); await sleep(600);
const aBefore=errs.length;
await ev(`App.sendAgent('pay a vendor 1 USDC')`);
for(let i=0;i<30;i++){ const busy=await ev('App.agent.busy'); if(busy===false && i>1) break; await sleep(1500); }
out.agent = {
  thread: JSON.parse(await ev(`JSON.stringify((App.agent.thread||[]).map(m=>m.role==='action'?('['+m.kind+(m.hash?' '+m.hash.slice(0,8):'')+(m.error?' ERR:'+m.error:'')+']'):(m.role+': '+(m.text||'').slice(0,90))))`)||'[]'),
  blocked: await ev('App.agent.blocked'),
  newErrs: errs.slice(aBefore)
};

out.totalConsoleErrors = errs.length;
out.totalNetFail = netfail.length;
out.allNetFail = netfail.slice(0,40);

console.log('=== AUDIT ===');
console.log(JSON.stringify(out,null,2));
ws.close(); chrome.kill('SIGKILL'); try{fs.rmSync(ud,{recursive:true,force:true});}catch{}
await sleep(200); process.exit(0);
