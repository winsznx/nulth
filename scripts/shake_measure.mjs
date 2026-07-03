// Forensic shake measurement on the live Nulth deploy via headless Chrome + CDP.
import { spawn } from 'child_process';
import fs from 'fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.TARGET_URL || 'https://nulth-production.up.railway.app/';
const PORT = 9433;
const ud = '/private/tmp/nulth_shake_' + process.pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-sandbox',
  '--window-size=1440,900', `--user-data-dir=${ud}`,
  `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });

async function wsu(){ for(let i=0;i<60;i++){ try{ const l=await (await fetch(`http://localhost:${PORT}/json/list`)).json(); const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl); if(p)return p.webSocketDebuggerUrl;}catch{} await sleep(200);} throw 'no cdp'; }

await sleep(1500);
const ws = new WebSocket(await wsu()); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0; const pend=new Map();
ws.onmessage=m=>{const o=JSON.parse(m.data);if(o.id&&pend.has(o.id)){pend.get(o.id)(o);pend.delete(o.id);}};
const cmd=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async(e,aw)=>{const r=await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:!!aw});
  if(r.result&&r.result.exceptionDetails) return {__err:r.result.exceptionDetails.text};
  return r.result&&r.result.result?r.result.result.value:undefined;};

await cmd('Runtime.enable'); await cmd('Page.enable');

// Install CLS observer via addScriptToEvaluateOnNewDocument BEFORE navigation.
await cmd('Page.addScriptToEvaluateOnNewDocument',{source:`
  window.__cls=0; window.__clsEntries=[];
  try{ new PerformanceObserver((list)=>{ for(const e of list.getEntries()){ if(!e.hadRecentInput){ window.__cls+=e.value;
    let src=null; if(e.sources&&e.sources.length){ const s=e.sources.reduce((a,b)=>((a.currentRect?.width*a.currentRect?.height||0)>=(b.currentRect?.width*b.currentRect?.height||0)?a:b));
      src={node:(s.node&&s.node.nodeName)||null, id:(s.node&&s.node.id)||null, rect:s.currentRect}; }
    window.__clsEntries.push({value:e.value, src}); } } }).observe({type:'layout-shift',buffered:true}); }catch(err){ window.__clsErr=String(err); }
`});

await cmd('Page.navigate',{url:URL}); await sleep(1800);
for(let i=0;i<25;i++){ if(await ev('window.App && App.live && App.live.loading')===false) break; await sleep(600); }

const out={};

// scripted scroll 0 -> bottom -> back, letting rAF handlers run
await ev(`(async()=>{ const H=document.documentElement.scrollHeight; const step=Math.max(200,Math.floor(H/24));
  for(let y=0;y<=H;y+=step){ window.scrollTo(0,y); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); }
  for(let y=H;y>=0;y-=step){ window.scrollTo(0,y); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); }
  window.scrollTo(0,0); return true; })()`, true);
await sleep(500);

// ---- 1. LAYOUT SHIFT (CLS) ----
out.cls = await ev('window.__cls');
out.clsErr = await ev('window.__clsErr||null');
out.clsTop = await ev('JSON.stringify((window.__clsEntries||[]).sort((a,b)=>b.value-a.value).slice(0,4))');

// ---- 2. SCROLLBAR TOGGLE on LANDING (rest) ----
out.landing_gap_rest = await ev('window.innerWidth - document.documentElement.clientWidth');
out.landing_innerW = await ev('window.innerWidth');
out.landing_clientW = await ev('document.documentElement.clientWidth');
out.landing_scrollH = await ev('document.documentElement.scrollHeight');
out.landing_innerH = await ev('window.innerHeight');

// ---- 3. DYNAMIC-ISLAND NAV HEIGHT across the 40px threshold ----
const navProbe = await ev(`(async()=>{ const res=[]; const ys=[0,30,45,60,200];
  for(const y of ys){ window.scrollTo(0,y);
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    await new Promise(r=>setTimeout(r,420)); // let the .35s nav transition settle
    const nav=document.getElementById('cv-nav'); const ni=document.getElementById('cv-nav-inner');
    res.push({y, navH: nav?Math.round(nav.getBoundingClientRect().height*100)/100:null,
      navOffsetH: nav?nav.offsetHeight:null, innerH: ni?Math.round(ni.getBoundingClientRect().height*100)/100:null,
      scrollH: document.documentElement.scrollHeight,
      gap: window.innerWidth - document.documentElement.clientWidth }); }
  window.scrollTo(0,0); return JSON.stringify(res); })()`, true);
out.navProbe = navProbe;

// ---- 2b/2c. DASHBOARD scrollbar toggle: enter app, cycle views, watch the gap ----
// App is module-scoped `const App` (not on window); a bare reference resolves via scope chain.
out.hasApp = await ev('typeof App!=="undefined" && !!App.nav');
const dash = await ev(`(async()=>{ const rec=[]; const gap=()=>window.innerWidth-document.documentElement.clientWidth;
  const snap=(label)=>{ const m=document.getElementById('cv-main');
    rec.push({label, gap:gap(), innerW:window.innerWidth, clientW:document.documentElement.clientWidth,
      docScrollH:document.documentElement.scrollHeight, docClientH:document.documentElement.clientHeight,
      mainScrollH:m?m.scrollHeight:null, mainClientH:m?m.clientHeight:null}); };
  if(typeof App==='undefined'||!App.nav) return JSON.stringify({err:'no App.nav'});
  const views=['dashboard','pay','activity','policy','compare','agent','breaking','verify','account','create'];
  App.nav('dashboard'); await new Promise(r=>setTimeout(r,800)); snap('dashboard');
  for(const v of views.slice(1)){ try{ App.nav(v); }catch(e){}
    await new Promise(r=>setTimeout(r,700));
    snap(v); }
  App.nav('landing'); await new Promise(r=>setTimeout(r,700)); snap('back-to-landing');
  return JSON.stringify(rec); })()`, true);
out.dash = dash;

// ---- 2d. Pendulum: rapid short<->tall view TOGGLE, measuring the scrollbar gap each flip ----
const toggleTest = await ev(`(async()=>{ const gap=()=>window.innerWidth-document.documentElement.clientWidth;
  if(typeof App==='undefined'||!App.nav) return JSON.stringify({err:'no App'});
  const seq=[]; const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
  const flip=[['activity','tall'],['policy','short'],['activity','tall'],['policy','short'],['activity','tall'],['policy','short']];
  for(const [v,kind] of flip){ App.nav(v); await wait(650);
    const m=document.getElementById('cv-main');
    seq.push({view:v,kind,gap:gap(),docScrollH:document.documentElement.scrollHeight,
      mainScrollH:m?m.scrollHeight:null,mainClientH:m?m.clientHeight:null}); }
  return JSON.stringify(seq); })()`, true);
out.toggleTest = toggleTest;

// ---- 2e. Also check whether html/body ever scrolls (vs only #cv-main) in dashboard ----
out.dashDocOverflow = await ev(`(()=>{ if(typeof App==='undefined') return null; App.nav('activity');
  return new Promise(r=>setTimeout(()=>{ const cs=getComputedStyle(document.documentElement);
    r(JSON.stringify({htmlOverflowY:cs.overflowY, docScrollH:document.documentElement.scrollHeight,
      docClientH:document.documentElement.clientHeight, gap:window.innerWidth-document.documentElement.clientWidth})); },700)); })()`, true);

console.log('=== RESULTS ===');
console.log(JSON.stringify(out,null,2));

ws.close(); chrome.kill('SIGKILL'); try{fs.rmSync(ud,{recursive:true,force:true});}catch{}
await sleep(200); process.exit(0);
