// Measure DEPTH-16 proving in Node via groth16.fullProve (witness + proof), real input.
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const snarkjs = require('/Users/mac/covenant/circuits/node_modules/snarkjs');

const B = '/Users/mac/covenant';
const s = JSON.parse(fs.readFileSync(`${B}/build/policy_secret.json`));
const wasm = `${B}/circuits/build/policy_js/policy.wasm`;
const zkey = `${B}/circuits/build/policy_final.zkey`;
const vk = JSON.parse(fs.readFileSync(`${B}/circuits/build/verification_key.json`));
const input = {
  amount: '10000000', dest: s.destLeaf, policy_commitment: s.commitment, allowlist_root: s.root,
  sigpayload_hi: '179818234020841234182340812341234012340', sigpayload_lo: '99812340981234098123409812340981234098',
  cap: s.cap, salt: s.salt, path: s.path, index_bits: s.index_bits,
};
const ITERS = Number(process.env.ITERS || 3);
const times = [];
let ok = false, peak = 0;
for (let i = 0; i < ITERS; i++) {
  const t = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  const dt = Date.now() - t;
  ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  peak = Math.max(peak, process.memoryUsage().rss);
  times.push(dt);
  console.log(`iter ${i + 1}: fullProve=${dt}ms verify=${ok}`);
}
const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
console.log(`NODE_RESULT depth=16 iters=${ITERS} fullProve_avg=${avg}ms fullProve_best=${Math.min(...times)}ms verify=${ok} rss_peak_mb=${Math.round(peak / 1048576)}`);
process.exit(0);
