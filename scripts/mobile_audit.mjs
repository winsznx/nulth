// Mobile audit: emulate a 390x844 phone, capture FULL-PAGE screenshots of every view.
import { spawn } from 'child_process';
import fs from 'fs';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const B=process.env.TARGET_URL||'http://localhost:8099';
const P=9520, ud='/private/tmp/nulth_m_'+process.pid, sleep=ms=>new Promise(r=>setTimeout(r,ms));
const OUT=process.env.OUT||'/private/tmp/mobile';
try{fs.mkdirSync(OUT,{recursive:true});}catch{}
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox',`--user-data-dir=${ud}`,`--remote-debugging-port=${P}`,'about:blank'],{stdio:'ignore'});
async function wsu(){for(let i=0;i<60;i++){try{const l=await(await fetch(`http://localhost:${P}/json/list`)).json();const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl;}catch{}await sleep(200);}throw'no cdp';}
await sleep(1400);const ws=new WebSocket(await wsu());await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0;const pend=new Map();const errs=[];
ws.onmessage=m=>{const o=JSON.parse(m.data);if(o.id&&pend.has(o.id)){pend.get(o.id)(o);pend.delete(o.id);}if(o.method==='Runtime.consoleAPICalled'&&o.params.type==='error')errs.push((o.params.args||[]).map(a=>a.value||a.description).join(' ').slice(0,120));};
const cmd=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async(e,aw)=>{const r=await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:!!aw});return r.result&&r.result.result?r.result.result.value:undefined;};
await cmd('Runtime.enable');await cmd('Page.enable');
await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
await cmd('Page.navigate',{url:B+'/'});await sleep(2500);
for(let i=0;i<25;i++){if(await ev('window.App&&App.live&&App.live.loading')===false)break;await sleep(500);}
async function shot(name){ await sleep(500);
  const lm=await cmd('Page.getLayoutMetrics'); const cs=(lm.result&&lm.result.cssContentSize)||(lm.result&&lm.result.contentSize)||{width:390,height:844};
  const h=Math.min(Math.ceil(cs.height), 8000);
  const s=await cmd('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:390,height:h,scale:1}});
  if(s.result&&s.result.data){ fs.writeFileSync(OUT+'/'+name+'.png', Buffer.from(s.result.data,'base64'));
    const gap=await ev('window.innerWidth-document.documentElement.clientWidth');
    const hover=await ev('document.documentElement.scrollWidth>document.documentElement.clientWidth+2');
    console.log(name.padEnd(12), 'h='+h, 'hOverflow='+hover, 'scrollW='+(await ev('document.documentElement.scrollWidth'))); }
}
await ev('window.scrollTo(0,0)'); await shot('01-landing');
const views=['dashboard','pay','activity','policy','compare','agent','breaking','verify','account','create'];
for(const v of views){ await ev("App.nav('"+v+"')"); await sleep(900); await ev('window.scrollTo(0,0)'); await shot((views.indexOf(v)+2).toString().padStart(2,'0')+'-'+v); }
console.log('console errors:', errs.length?errs.slice(0,5).join(' | '):'NONE');
console.log('OUT:', OUT);
ws.close();chrome.kill('SIGKILL');try{fs.rmSync(ud,{recursive:true,force:true});}catch{}process.exit(0);
