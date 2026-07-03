// Verify the dynamic interactions render: agent attack interception + Verify slider flip + deck reject.
import http from 'http'; import fs from 'fs'; import path from 'path'; import { spawn } from 'child_process';
const ROOT='/Users/mac/covenant/web', OUT='/Users/mac/covenant/web/.shots', PORT=8124;
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIME={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
const server=http.createServer((q,s)=>{ let f=path.join(ROOT, q.url==='/'?'index.html':decodeURIComponent(q.url.split('?')[0])); fs.readFile(f,(e,d)=>{ if(e){s.writeHead(404);s.end();return;} s.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream'}); s.end(d); }); });
await new Promise(r=>server.listen(PORT,r));
const ud='/tmp/covix_'+process.pid;
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--disable-dev-shm-usage',`--user-data-dir=${ud}`,'--remote-debugging-port=9344','--window-size=1320,900','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wsu(){ for(let i=0;i<50;i++){ try{ const l=await (await fetch('http://localhost:9344/json/list')).json(); const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl); if(p)return p.webSocketDebuggerUrl; }catch{} await sleep(200);} throw 'no cdp'; }
const ws=new WebSocket(await wsu()); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0; const pend=new Map(); ws.onmessage=m=>{const o=JSON.parse(m.data); if(o.id&&pend.has(o.id)){pend.get(o.id)(o);pend.delete(o.id);}};
const cmd=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=expr=>cmd('Runtime.evaluate',{expression:expr,returnByValue:true});
const snap=async name=>{ const r=await cmd('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:1280,height:900,scale:1}}); fs.writeFileSync(path.join(OUT,name),Buffer.from(r.result.data,'base64')); console.log('shot',name); };
await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Emulation.setDeviceMetricsOverride',{width:1280,height:860,deviceScaleFactor:1,mobile:false});
await cmd('Page.navigate',{url:`http://localhost:${PORT}/`}); await sleep(1100);

// 1) agent attack interception
await ev("App.nav('agent')"); await sleep(300);
await ev("App.injectAttack('prompt')"); await sleep(2600);
const mon=await ev("document.body.innerText.includes('Intrusion Intercepted')+'|'+document.body.innerText.includes('BadDestBinding')");
console.log('agent interception present:', mon.result.result.value);
await snap('ix-agent-intercept.png');

// 2) verify slider flip to pass
await ev("App.nav('verify')"); await sleep(300);
await ev("App.onSlider('probe','92000')"); await sleep(500);
const vp=await ev("document.getElementById('cv-verdict').innerText.includes('VALID')");
console.log('verify flips to VALID at probe>cap:', vp.result.result.value);
await snap('ix-verify-pass.png');

// 3) deck reject
await ev("App.nav('breaking'); App.runDeck('malleability')"); await sleep(2600);
const dk=await ev("document.body.innerText.includes('REJECTED_BY_AUTH_LAYER')+'|'+document.body.innerText.includes('BadProof')");
console.log('deck reject present:', dk.result.result.value);
await snap('ix-deck-reject.png');

ws.close(); chrome.kill('SIGKILL'); server.close(); try{fs.rmSync(ud,{recursive:true,force:true});}catch{} process.exit(0);
