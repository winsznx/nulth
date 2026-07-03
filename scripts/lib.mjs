// snarkjs (bn128) -> soroban crypto::bn254 byte serialization.
// G1 BytesN<64>  = be(x)[32] || be(y)[32]            (canonical, big-endian)
// G2 BytesN<128> = be(x.c1) || be(x.c0) || be(y.c1) || be(y.c0)  (c1 FIRST, EIP-197)
// Proof.a is RAW pi_a — the contract negates A itself.
import * as SDK from '@stellar/stellar-sdk';

export const decToBe32 = (dec) => {
  let v = BigInt(dec);
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  if (v !== 0n) throw new Error('field element overflows 32 bytes: ' + dec);
  return b;
};

export const g1Bytes = (p) => Buffer.concat([decToBe32(p[0]), decToBe32(p[1])]);

export const g2Bytes = (p, order = 'c1c0') => {
  const [[xc0, xc1], [yc0, yc1]] = p;
  return order === 'c1c0'
    ? Buffer.concat([decToBe32(xc1), decToBe32(xc0), decToBe32(yc1), decToBe32(yc0)])
    : Buffer.concat([decToBe32(xc0), decToBe32(xc1), decToBe32(yc0), decToBe32(yc1)]);
};

export const u256ScVal = (dec) => {
  let v = BigInt(dec);
  const p = [];
  for (let i = 0; i < 4; i++) { p.push(v & ((1n << 64n) - 1n)); v >>= 64n; }
  return SDK.xdr.ScVal.scvU256(new SDK.xdr.UInt256Parts({
    hiHi: new SDK.xdr.Uint64(p[3]), hiLo: new SDK.xdr.Uint64(p[2]),
    loHi: new SDK.xdr.Uint64(p[1]), loLo: new SDK.xdr.Uint64(p[0]),
  }));
};

const bytes = (buf) => SDK.xdr.ScVal.scvBytes(buf);
const entry = (k, v) => new SDK.xdr.ScMapEntry({ key: SDK.xdr.ScVal.scvSymbol(k), val: v });

// keys must be in sorted symbol order: alpha, beta, delta, gamma, ic
export const vkScVal = (vk, order = 'c1c0') => SDK.xdr.ScVal.scvMap([
  entry('alpha', bytes(g1Bytes(vk.vk_alpha_1))),
  entry('beta', bytes(g2Bytes(vk.vk_beta_2, order))),
  entry('delta', bytes(g2Bytes(vk.vk_delta_2, order))),
  entry('gamma', bytes(g2Bytes(vk.vk_gamma_2, order))),
  entry('ic', SDK.xdr.ScVal.scvVec(vk.IC.map((p) => bytes(g1Bytes(p))))),
]);

// keys: a, b, c
export const proofScVal = (proof, order = 'c1c0') => SDK.xdr.ScVal.scvMap([
  entry('a', bytes(g1Bytes(proof.pi_a))),
  entry('b', bytes(g2Bytes(proof.pi_b, order))),
  entry('c', bytes(g1Bytes(proof.pi_c))),
]);

// keys: a, b, c, pub_signals
export const proofSigScVal = (proof, pub, order = 'c1c0') => SDK.xdr.ScVal.scvMap([
  entry('a', bytes(g1Bytes(proof.pi_a))),
  entry('b', bytes(g2Bytes(proof.pi_b, order))),
  entry('c', bytes(g1Bytes(proof.pi_c))),
  entry('pub_signals', SDK.xdr.ScVal.scvVec(pub.map(u256ScVal))),
]);

export const pubVecScVal = (pub) => SDK.xdr.ScVal.scvVec(pub.map(u256ScVal));

// vk as the hex-bytes JSON the `stellar contract deploy -- --vk <json>` CLI expects.
export const vkCliHex = (vk, order = 'c1c0') => ({
  alpha: g1Bytes(vk.vk_alpha_1).toString('hex'),
  beta: g2Bytes(vk.vk_beta_2, order).toString('hex'),
  gamma: g2Bytes(vk.vk_gamma_2, order).toString('hex'),
  delta: g2Bytes(vk.vk_delta_2, order).toString('hex'),
  ic: vk.IC.map((p) => g1Bytes(p).toString('hex')),
});

// Split a 32-byte Buffer (signature_payload) into the two 128-bit halves the
// circuit/contract use: hi = decimal of bytes[0..16] BE, lo = decimal of bytes[16..32] BE.
export const payloadHalves = (buf32) => {
  if (buf32.length !== 32) throw new Error('signature_payload must be 32 bytes');
  return {
    hi: BigInt('0x' + buf32.subarray(0, 16).toString('hex')).toString(),
    lo: BigInt('0x' + buf32.subarray(16, 32).toString('hex')).toString(),
  };
};

// Compute the Soroban signature_payload for an address auth entry, exactly as the host does:
// sha256(xdr(HashIdPreimage::SorobanAuthorization{ networkId, nonce, signatureExpirationLedger, invocation })).
export const sorobanAuthPayload = (entry, networkPassphrase) => {
  const cred = entry.credentials().address();
  const networkId = SDK.hash(Buffer.from(networkPassphrase));
  const preimage = SDK.xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new SDK.xdr.HashIdPreimageSorobanAuthorization({
      networkId,
      nonce: cred.nonce(),
      signatureExpirationLedger: cred.signatureExpirationLedger(),
      invocation: entry.rootInvocation(),
    })
  );
  return SDK.hash(preimage.toXDR());
};
