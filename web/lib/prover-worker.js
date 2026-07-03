// Off-main-thread Groth16 prover. Runs snarkjs.fullProve in a Web Worker so a ~50 MB proving
// spike + ~1 s of CPU never freeze or OOM the page's main thread (matters most on mobile). Same
// DEPTH-16 circuit, same 65,536-leaf model — only the execution context changes. The main thread
// falls back to inline proving if a Worker is unavailable, so this can never make things worse.
importScripts('../prover/snarkjs.min.js');
self.onmessage = async (e) => {
  const { id, input, wasm, zkey } = e.data || {};
  try {
    const out = await snarkjs.groth16.fullProve(input, wasm, zkey);
    self.postMessage({ id, ok: true, proof: out.proof, publicSignals: out.publicSignals });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
