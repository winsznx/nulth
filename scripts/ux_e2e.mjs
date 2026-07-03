// Headless UX pass test: walks all 11 routes (console errors), forbidden-phrase + number scan
// on the new landing, exercises the in-app funding helpers ON-CHAIN (real friendbot XLM + real
// USDC seed), and captures screenshots of the new landing + nav. Reduced-motion fallback checked.
// (Deploy/pay from a fresh account needs a keypair, not Freighter — proven by create_user.mjs.)
import http from 'http'; import fs from 'fs'; import path from 'path'; import { spawn } from 'child_process';
const ROOT='/Users/mac/covenant/web', OUT='/Users/mac/covenant/web/.shots', PORT=8151;
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME={'.html':'text/html','.js':'text/javascript','.json':'application/json','.wasm':'application/wasm','.png':'image/png'};
fs.mkdirSync(OUT,{recursive:true});
const server=http.createServer((q,s)=>{ let f=path.join(ROOT,q.url==='/'?'index.html':decodeURIComponent(q.url.split('?')[0])); fs.readFile(f,(e,d)=>{ if(e){s.writeHead(404);s.end('nf');return;} s.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream'}); s.end(d); }); });
await new Promise(r=>server.listen(PORT,r));
const ud='/tmp/covux_'+process.pid;
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--disable-dev-shm-usage',`--user-data-dir=${ud}`,'--remote-debugging-port=9361','--window-size=1440,900','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wsu(){ for(let i=0;i<60;i++){ try{ const l=await (await fetch('http://localhost:9361/json/list')).json(); const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl); if(p)return p.webSocketDebuggerUrl;}catch{} await sleep(200);} throw 'no cdp'; }
const ws=new WebSocket(await wsu()); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0; const pend=new Map(); let errs=[];
ws.onmessage=m=>{ const o=JSON.parse(m.data);
  if(o.id&&pend.has(o.id)){pend.get(o.id)(o);pend.delete(o.id);}
  if(o.method==='Runtime.consoleAPICalled'&&o.params.type==='error') errs.push((o.params.args||[]).map(a=>a.value!==undefined?a.value:a.description).join(' '));
  if(o.method==='Runtime.exceptionThrown') errs.push('EXC: '+(o.params.exceptionDetails.exception?.description||o.params.exceptionDetails.text));
};
const cmd=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async(e,aw)=>{ const r=await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:!!aw}); if(r.result&&r.result.exceptionDetails) return {__exc:String(r.result.exceptionDetails.exception&&r.result.exceptionDetails.exception.description||r.result.exceptionDetails.text)}; return r.result&&r.result.result?r.result.result.value:undefined; };
const snap=async n=>{ const r=await cmd('Page.captureScreenshot',{format:'png'}); if(r.result&&r.result.data){fs.writeFileSync(path.join(OUT,n),Buffer.from(r.result.data,'base64'));console.log('  shot',n);} };
await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
await cmd('Page.navigate',{url:`http://localhost:${PORT}/`}); await sleep(1800);

console.log('=== globals + new funding helpers ===');
console.log(await ev('JSON.stringify({chain:typeof window.CovenantChain,friendbotFund:typeof CovenantChain.friendbotFund,seedUsdc:typeof CovenantChain.seedUsdc,operatorUsdc:typeof CovenantChain.operatorUsdc,opKey:CovenantChain.hasOperatorKey(),opPub:CovenantChain.operatorPub&&CovenantChain.operatorPub()})'));
for(let i=0;i<30;i++){ if(await ev('App.live.loading')===false) break; await sleep(700); }

console.log('\n=== forbidden-phrase + number scan (landing) ===');
await ev("location.hash='';App.nav('landing')"); await sleep(700);
console.log(await ev('(function(){var t=document.body.innerText;return JSON.stringify({hasPrimitive:/primitive/i.test(t),hasHackathon:/hackathon/i.test(t),has56:/\\b56\\b/.test(t),has173ms:/173\\s?ms/i.test(t),has728:/\\b728\\b/.test(t),cost8537:t.indexOf("8.537")>=0,tests46:t.indexOf("46")>=0,slots65536:t.indexOf("65,536")>=0,adminCaveat:t.toLowerCase().indexOf("cannot spend in one step")>=0,heroDrained:t.indexOf("drained")>=0});})()'));

console.log('\n=== 11-route walk · console errors per route ===');
const routes=['landing','dashboard','pay','policy','activity','agent','breaking','verify','account','create','compare'];
const perRoute={};
for(const r of routes){ errs=[]; await ev("App.nav('"+r+"')"); await sleep(r==='landing'?900:650); perRoute[r]=errs.slice(); console.log('  '+r.padEnd(10)+' errors: '+(errs.length?JSON.stringify(errs):'0')); }

console.log('\n=== scroll showcase: LHS text changes as the stack advances ===');
await ev("App.nav('landing')"); await sleep(700);
const sh0=await ev("(function(){var e=document.getElementById('cv-show-title');return e?e.textContent.slice(0,40):'(no showcase title)';})()");
await ev("(function(){var s=document.getElementById('cv-showcase');if(s){window.scrollTo(0, s.offsetTop + s.offsetHeight*0.55);}})()"); await sleep(700);
const sh1=await ev("(function(){var e=document.getElementById('cv-show-title');return e?e.textContent.slice(0,40):'(no showcase title)';})()");
console.log('  showcase title @top   :', sh0);
console.log('  showcase title @55%   :', sh1, sh0!==sh1?'· CHANGED ✓':'· (unchanged)');

console.log('\n=== screenshots (desktop 1440) ===');
await ev('window.scrollTo(0,0)'); await sleep(500); await snap('ux-landing-hero.png');
await ev("(function(){var s=document.getElementById('cv-showcase');if(s)window.scrollTo(0,s.offsetTop+s.offsetHeight*0.5);})()"); await sleep(700); await snap('ux-landing-showcase.png');
await ev("(function(){window.scrollTo(0,document.body.scrollHeight);})()"); await sleep(700); await snap('ux-landing-footer.png');
await ev("App.nav('dashboard')"); await sleep(800); await snap('ux-nav-dashboard.png');
await ev("App.nav('create')"); await sleep(500); await snap('ux-create-funding.png');

console.log('\n=== reduced-motion fallback (prefers-reduced-motion: reduce) ===');
await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
await ev("App.nav('dashboard')"); await sleep(200); await ev("App.nav('landing');App.render()"); await sleep(700);
console.log(await ev('JSON.stringify({reducedFallbackGrid:!document.getElementById("cv-card-0")&&!!document.getElementById("cv-showcase"),fourCards:(document.querySelectorAll("[data-act=\\"nav:agent\\"]").length>0)})'));
await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});

console.log('\n=== ON-CHAIN: in-app friendbot (XLM) for a fresh wallet ===');
await ev("App.nav('landing')"); await sleep(300);
const fb=await ev("(async function(){var kp=window.StellarSdk.Keypair.random();var r=await window.CovenantChain.friendbotFund(kp.publicKey());return JSON.stringify({pub:kp.publicKey(),status:r.status,hash:r.hash});})()", true);
console.log('  friendbot:', fb);

console.log('\n=== ON-CHAIN: in-app seedUsdc (operator -> demo account, 0.05 USDC) ===');
const seed=await ev("(async function(){var acct=window.COVENANT.account;var before=await window.CovenantChain.sacBalance(acct);var r=await window.CovenantChain.seedUsdc(acct, 500000n);var after=await window.CovenantChain.sacBalance(acct);return JSON.stringify({status:r.status,hash:r.hash,deltaStroops:String(after-before)});})()", true);
console.log('  seedUsdc:', seed);

const totalErrs=Object.values(perRoute).reduce((a,b)=>a+b.length,0);
console.log('\n=== SUMMARY === total console errors across 11 routes:', totalErrs);
try{ws.close();}catch(_){}
try{chrome.kill();}catch(_){}
server.close();
await sleep(300);
process.exit(0);
