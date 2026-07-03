// Circuit tests (snarkjs): Tier-1 disclosure + policy circuit. A satisfiable input yields a
// verifying proof; an out-of-policy input makes the circuit UNSATISFIABLE (witness abort).
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const snarkjs = require('/Users/mac/covenant/circuits/node_modules/snarkjs');
const B = '/Users/mac/covenant';
const secret = JSON.parse(fs.readFileSync(`${B}/build/policy_secret.json`));
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n); } };

// ---------- disclosure (Tier-1: cap <= regulatory_max, commitment opening) ----------
const dWasm = `${B}/circuits/build/disclosure_js/disclosure.wasm`, dZkey = `${B}/circuits/build/disclosure_final.zkey`;
const dVk = JSON.parse(fs.readFileSync(`${B}/circuits/build/disclosure_vk.json`));
const disc = (regMax) => snarkjs.groth16.fullProve({ policy_commitment: secret.commitment, regulatory_max: String(regMax), cap: secret.cap, salt: secret.salt }, dWasm, dZkey);
console.log('disclosure circuit:');
try { const { proof, publicSignals } = await disc('5000000000'); ok('limit > cap -> verifying proof', await snarkjs.groth16.verify(dVk, publicSignals, proof)); } catch { ok('limit > cap -> verifying proof', false); }
try { const { proof, publicSignals } = await disc(secret.cap); ok('limit == cap -> verifying proof (boundary)', await snarkjs.groth16.verify(dVk, publicSignals, proof)); } catch { ok('limit == cap -> verifying proof (boundary)', false); }
try { await disc('50000000'); ok('limit < cap -> witness abort', false); } catch { ok('limit < cap -> witness abort', true); }
try { await snarkjs.groth16.fullProve({ policy_commitment: '999', regulatory_max: '5000000000', cap: secret.cap, salt: secret.salt }, dWasm, dZkey); ok('wrong commitment -> witness abort', false); } catch { ok('wrong commitment -> witness abort', true); }

// ---------- policy (amount<=cap + dest in allowlist + commitment opening) ----------
const pWasm = `${B}/circuits/build/policy_js/policy.wasm`, pZkey = `${B}/circuits/build/policy_final.zkey`;
const pVk = JSON.parse(fs.readFileSync(`${B}/circuits/build/verification_key.json`));
const pin = (amount, dest, commitment) => ({ amount: String(amount), dest: dest || secret.destLeaf, policy_commitment: commitment || secret.commitment, allowlist_root: secret.root, sigpayload_hi: '1', sigpayload_lo: '2', cap: secret.cap, salt: secret.salt, path: secret.path, index_bits: secret.index_bits });
console.log('policy circuit:');
try { const { proof, publicSignals } = await snarkjs.groth16.fullProve(pin(10000000), pWasm, pZkey); ok('valid payment -> verifying proof', await snarkjs.groth16.verify(pVk, publicSignals, proof)); } catch { ok('valid payment -> verifying proof', false); }
try { await snarkjs.groth16.fullProve(pin((BigInt(secret.cap) + 1n).toString()), pWasm, pZkey); ok('over-cap -> witness abort', false); } catch { ok('over-cap -> witness abort', true); }
try { await snarkjs.groth16.fullProve(pin(10000000, '12345'), pWasm, pZkey); ok('non-allowlisted dest -> witness abort', false); } catch { ok('non-allowlisted dest -> witness abort', true); }

console.log(`circuit tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
