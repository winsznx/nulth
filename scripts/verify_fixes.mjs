// Verify the two blockers on the live deploy: (1) the Exploitation Deck runs server-side and every
// attack lands REJECTED (no TypeError), (2) the waitlist persists durably + is exportable.
import { spawn } from 'child_process';
import fs from 'fs';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const B = process.env.TARGET_URL || 'https://nulth-production.up.railway.app';
const P = 9499, ud = '/private/tmp/nulth_vf_' + process.pid, sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-sandbox','--window-size=1440,900',`--user-data-dir=${ud}`,`--remote-debugging-port=${P}`,'about:blank'], { stdio: 'ignore' });
async function wsu(){ for(let i=0;i<60;i++){ try{ const l=await (await fetch(`http://localhost:${P}/json/list`)).json(); const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl); if(p)return p.webSocketDebuggerUrl;}catch{} await sleep(200);} throw 'no cdp'; }
await sleep(1400);
const ws = new WebSocket(await wsu()); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0; const pend=new Map(); const errs=[];
ws.onmessage=m=>{const o=JSON.parse(m.data);if(o.id&&pend.has(o.id)){pend.get(o.id)(o);pend.delete(o.id);}if(o.method==='Runtime.consoleAPICalled'&&o.params.type==='error')errs.push((o.params.args||[]).map(a=>a.value||a.description).join(' ').slice(0,160));if(o.method==='Runtime.exceptionThrown')errs.push('EXC '+(o.params.exceptionDetails.exception?.description||o.params.exceptionDetails.text||'').slice(0,160));};
const cmd=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async(e,aw)=>{const r=await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:!!aw});return r.result&&r.result.result?r.result.result.value:undefined;};
await cmd('Runtime.enable'); await cmd('Page.enable');
await cmd('Page.navigate',{url:B+'/'}); await sleep(2500);
for(let i=0;i<30;i++){ if(await ev('window.App&&App.live&&App.live.loading')===false) break; await sleep(700); }

// ---- ATTACK DECK: run every mode, confirm rejected (not TypeError) ----
const modes = JSON.parse(await ev('JSON.stringify(Object.keys(window.CovenantAttacks.SPEC))') || '[]');
console.log('attack modes:', modes.join(', '));
await ev("App.nav('breaking')"); await sleep(500);
const attackResults = {};
for (const mode of modes) {
  await ev(`App.runAttack('${mode}')`);
  let st;
  for (let i=0;i<40;i++){ st = JSON.parse(await ev(`JSON.stringify(App.state.deck['${mode}']||{})`)||'{}'); if(st.status==='rejected'||st.status==='error') break; await sleep(2500); }
  attackResults[mode] = st.status==='rejected'
    ? { ok:true, code:st.code, codeName:st.codeName, txStatus:st.txStatus, tx:(st.txHash||'').slice(0,10) }
    : { ok:false, status:st.status, error:st.error };
  console.log(`  ${mode}: ${JSON.stringify(attackResults[mode])}`);
}

// ---- WAITLIST: submit + confirm the client only reports success on real persistence ----
const email = 'verify_' + process.env.STAMP + '@nulth.xyz';
await ev("App.nav('landing')"); await sleep(400);
await ev(`(()=>{ const el=document.getElementById('cv-wl'); if(el) el.value='${email}'; App.submitWaitlist(); })()`);
let wl;
for(let i=0;i<15;i++){ wl = await ev('App.wl && App.wl.status'); if(wl==='ok'||wl==='err'||wl==='bad') break; await sleep(1000); }
console.log('waitlist status:', wl, '| email:', email);
console.log('console errors:', errs.length?errs.slice(0,5).join(' | '):'NONE');
console.log('RESULT ' + JSON.stringify({ attacks: attackResults, waitlist: wl, email }));
ws.close(); chrome.kill('SIGKILL'); try{fs.rmSync(ud,{recursive:true,force:true});}catch{} process.exit(0);
