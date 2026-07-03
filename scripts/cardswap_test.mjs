// Headless test of the SCROLL-DRIVEN CardSwap showcase: scrolling advances the stack, the section
// stays sticky (overflow-x:clip doesn't break it), nothing is clipped into a box, no horizontal
// scrollbar, click->nav works, 0 console errors. Screenshots at two scroll depths.
import { spawn } from 'child_process';
import fs from 'fs';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const B=process.env.TARGET_URL||'http://localhost:8099';
const P=9512, ud='/private/tmp/nulth_cs2_'+process.pid, sleep=ms=>new Promise(r=>setTimeout(r,ms));
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--window-size=1440,900','--force-device-scale-factor=1',`--user-data-dir=${ud}`,`--remote-debugging-port=${P}`,'about:blank'],{stdio:'ignore'});
async function wsu(){for(let i=0;i<60;i++){try{const l=await(await fetch(`http://localhost:${P}/json/list`)).json();const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl;}catch{}await sleep(200);}throw'no cdp';}
await sleep(1400);const ws=new WebSocket(await wsu());await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0;const pend=new Map();const errs=[];
ws.onmessage=m=>{const o=JSON.parse(m.data);if(o.id&&pend.has(o.id)){pend.get(o.id)(o);pend.delete(o.id);}if(o.method==='Runtime.consoleAPICalled'&&o.params.type==='error')errs.push((o.params.args||[]).map(a=>a.value||a.description).join(' ').slice(0,160));if(o.method==='Runtime.exceptionThrown')errs.push('EXC '+(o.params.exceptionDetails.exception?.description||o.params.exceptionDetails.text||'').slice(0,160));};
const cmd=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async(e,aw)=>{const r=await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:!!aw});return r.result&&r.result.result?r.result.result.value:undefined;};
const shot=async(name)=>{const s=await cmd('Page.captureScreenshot',{format:'png'});if(s.result&&s.result.data){fs.writeFileSync('/private/tmp/'+name,Buffer.from(s.result.data,'base64'));console.log('screenshot:',name);}};
await cmd('Runtime.enable');await cmd('Page.enable');
await cmd('Page.navigate',{url:B+'/'});await sleep(2200);
for(let i=0;i<25;i++){if(await ev('window.App&&App.live&&App.live.loading')===false)break;await sleep(500);}
await sleep(500);
console.log('mountScroll present:', await ev('!!(window.CovenantCardSwap&&window.CovenantCardSwap.mountScroll)'));
console.log('cards:', await ev("document.querySelectorAll('.cv-cs-card').length"));
// geometry
const geo=JSON.parse(await ev("(function(){var s=document.getElementById('cv-showcase');var r=s.getBoundingClientRect();return JSON.stringify({top:r.top+window.scrollY, h:s.offsetHeight, vh:window.innerHeight});})()"));
const span=geo.h-geo.vh;
async function at(p, name){
  await ev('window.scrollTo(0,'+(geo.top+span*p)+')'); await sleep(450);
  const info=JSON.parse(await ev("(function(){var cont=document.getElementById('cv-cardswap');var cr=cont.getBoundingClientRect();var cards=[].slice.call(document.querySelectorAll('.cv-cs-card')).map(function(el){var cs=getComputedStyle(el);var m=new DOMMatrixReadOnly(cs.transform);return {op:+(+cs.opacity).toFixed(2), ty:Math.round(m.f), zi:cs.zIndex};});return JSON.stringify({contTop:Math.round(cr.top), gap:window.innerWidth-document.documentElement.clientWidth, hOver:document.documentElement.scrollWidth>document.documentElement.clientWidth, cards:cards});})()"));
  console.log('@p='+p+' contTop='+info.contTop+' gap='+info.gap+' hOverflow='+info.hOver);
  console.log('   cards(op,ty,z):', info.cards.map(c=>'('+c.op+','+c.ty+','+c.zi+')').join(' '));
  if(name) await shot(name);
  return info;
}
const a=await at(0.10,'cs_p10.png');
const b=await at(0.45,'cs_p45.png');
const c=await at(0.80,'cs_p80.png');
console.log('sticky holds (contTop ~equal across depths):', Math.abs(a.contTop-c.contTop)<8, '('+a.contTop+' vs '+c.contTop+')');
console.log('stack advanced (card0 opacity drops as we scroll):', a.cards[0].op, '->', c.cards[0].op);
// click front-ish card -> nav
await ev("(function(){var c=document.querySelector('.cv-cs-card[data-cvidx=\\'0\\']');if(c)c.click();})()"); await sleep(600);
console.log('click card0 -> screen:', await ev('App.state.screen'));
console.log('console errors:', errs.length?errs.slice(0,6).join(' | '):'NONE');
ws.close();chrome.kill('SIGKILL');try{fs.rmSync(ud,{recursive:true,force:true});}catch{}process.exit(0);
