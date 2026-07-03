import { spawn } from 'child_process';
import fs from 'fs';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const B=process.env.TARGET_URL||'http://localhost:8099';
const P=9513, ud='/private/tmp/nulth_hero_'+process.pid, sleep=ms=>new Promise(r=>setTimeout(r,ms));
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--window-size=1440,900','--force-device-scale-factor=1',`--user-data-dir=${ud}`,`--remote-debugging-port=${P}`,'about:blank'],{stdio:'ignore'});
async function wsu(){for(let i=0;i<60;i++){try{const l=await(await fetch(`http://localhost:${P}/json/list`)).json();const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl;}catch{}await sleep(200);}throw'no cdp';}
await sleep(1400);const ws=new WebSocket(await wsu());await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0;const pend=new Map();const errs=[];
ws.onmessage=m=>{const o=JSON.parse(m.data);if(o.id&&pend.has(o.id)){pend.get(o.id)(o);pend.delete(o.id);}if(o.method==='Runtime.consoleAPICalled'&&o.params.type==='error')errs.push((o.params.args||[]).map(a=>a.value||a.description).join(' ').slice(0,160));if(o.method==='Runtime.exceptionThrown')errs.push('EXC '+(o.params.exceptionDetails.exception?.description||o.params.exceptionDetails.text||'').slice(0,160));};
const cmd=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async(e,aw)=>{const r=await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:!!aw});return r.result&&r.result.result?r.result.result.value:undefined;};
await cmd('Runtime.enable');await cmd('Page.enable');
await cmd('Page.navigate',{url:B+'/'});await sleep(2200);
for(let i=0;i<25;i++){if(await ev('window.App&&App.live&&App.live.loading')===false)break;await sleep(500);}
await sleep(400);
console.log('H1:', await ev("(document.querySelector('h1')||{}).textContent"));
console.log('subhead has proof-authorized:', await ev("document.body.innerText.includes('proof-authorized Stellar account')"));
console.log('visual present (Same account/AUTHORIZED/REJECTED):', await ev("['Same account. Two payments.','AUTHORIZED','REJECTED'].every(s=>document.body.innerText.includes(s))"));
console.log('trust strip:', await ev("['No spending key','In-browser proving','65,536 private allowlist slots','Verified on Stellar testnet'].every(s=>document.body.innerText.includes(s))"));
console.log('attack-blocked CTA exists:', await ev("[].some.call(document.querySelectorAll('button'),b=>/See an attack blocked/.test(b.textContent))"));
console.log('gap(innerW-clientW):', await ev('window.innerWidth-document.documentElement.clientWidth'), '(expect 10)');
console.log('horizontal overflow?', await ev('document.documentElement.scrollWidth>document.documentElement.clientWidth'));
// click the attack CTA
await ev("(function(){var b=[].find.call(document.querySelectorAll('button'),x=>/See an attack blocked/.test(x.textContent));if(b)b.click();})()"); await sleep(600);
console.log('See-an-attack-blocked -> screen:', await ev('App.state.screen'));
await ev("App.nav('landing')"); await sleep(500); await ev('window.scrollTo(0,0)'); await sleep(300);
const shot=await cmd('Page.captureScreenshot',{format:'png'});
if(shot.result&&shot.result.data){fs.writeFileSync('/private/tmp/hero_fold.png',Buffer.from(shot.result.data,'base64'));console.log('screenshot: /private/tmp/hero_fold.png');}
console.log('console errors:', errs.length?errs.slice(0,6).join(' | '):'NONE');
ws.close();chrome.kill('SIGKILL');try{fs.rmSync(ud,{recursive:true,force:true});}catch{}process.exit(0);
