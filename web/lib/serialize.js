// Browser port of scripts/lib.mjs — the PROVEN snarkjs->soroban BN254 serialization
// and the Soroban signature_payload computation. Same logic, global StellarSdk + Buffer.
(function () {
  const SDK = window.StellarSdk;
  const Buf = window.Buffer;
  if (!SDK) throw new Error('StellarSdk not loaded');
  if (!Buf) throw new Error('Buffer global not available (needed for ScVal bytes)');

  const decToBe32 = (dec) => {
    let v = BigInt(dec);
    const b = Buf.alloc(32);
    for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
    if (v !== 0n) throw new Error('field element overflows 32 bytes: ' + dec);
    return b;
  };
  const g1Bytes = (p) => Buf.concat([decToBe32(p[0]), decToBe32(p[1])]);
  const g2Bytes = (p, order) => {
    order = order || 'c1c0';
    const xc0 = p[0][0], xc1 = p[0][1], yc0 = p[1][0], yc1 = p[1][1];
    return order === 'c1c0'
      ? Buf.concat([decToBe32(xc1), decToBe32(xc0), decToBe32(yc1), decToBe32(yc0)])
      : Buf.concat([decToBe32(xc0), decToBe32(xc1), decToBe32(yc0), decToBe32(yc1)]);
  };
  const u256ScVal = (dec) => {
    let v = BigInt(dec);
    const p = [];
    for (let i = 0; i < 4; i++) { p.push(v & ((1n << 64n) - 1n)); v >>= 64n; }
    return SDK.xdr.ScVal.scvU256(new SDK.xdr.UInt256Parts({
      hiHi: new SDK.xdr.Uint64(p[3]), hiLo: new SDK.xdr.Uint64(p[2]),
      loHi: new SDK.xdr.Uint64(p[1]), loLo: new SDK.xdr.Uint64(p[0]),
    }));
  };
  const bytes = (b) => SDK.xdr.ScVal.scvBytes(b);
  const entry = (k, v) => new SDK.xdr.ScMapEntry({ key: SDK.xdr.ScVal.scvSymbol(k), val: v });

  // keys sorted: a, b, c, pub_signals
  const proofSigScVal = (proof, pub, order) => SDK.xdr.ScVal.scvMap([
    entry('a', bytes(g1Bytes(proof.pi_a))),
    entry('b', bytes(g2Bytes(proof.pi_b, order))),
    entry('c', bytes(g1Bytes(proof.pi_c))),
    entry('pub_signals', SDK.xdr.ScVal.scvVec(pub.map(u256ScVal))),
  ]);

  // 32-byte signature_payload -> two 128-bit halves (BE decimal)
  const payloadHalves = (buf32) => {
    const b = Buf.from(buf32);
    if (b.length !== 32) throw new Error('signature_payload must be 32 bytes');
    return {
      hi: BigInt('0x' + b.subarray(0, 16).toString('hex')).toString(),
      lo: BigInt('0x' + b.subarray(16, 32).toString('hex')).toString(),
    };
  };

  // sha256(xdr(HashIdPreimage::SorobanAuthorization{ networkId, nonce, expiration, invocation }))
  const sorobanAuthPayload = (authEntry, networkPassphrase) => {
    const cred = authEntry.credentials().address();
    const networkId = SDK.hash(Buf.from(networkPassphrase));
    const preimage = SDK.xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new SDK.xdr.HashIdPreimageSorobanAuthorization({
        networkId,
        nonce: cred.nonce(),
        signatureExpirationLedger: cred.signatureExpirationLedger(),
        invocation: authEntry.rootInvocation(),
      })
    );
    return SDK.hash(preimage.toXDR());
  };

  // VerificationKey map (keys sorted: alpha, beta, delta, gamma, ic) — for verify_proof
  const vkScVal = (vk, order) => SDK.xdr.ScVal.scvMap([
    entry('alpha', bytes(g1Bytes(vk.vk_alpha_1))),
    entry('beta', bytes(g2Bytes(vk.vk_beta_2, order))),
    entry('delta', bytes(g2Bytes(vk.vk_delta_2, order))),
    entry('gamma', bytes(g2Bytes(vk.vk_gamma_2, order))),
    entry('ic', SDK.xdr.ScVal.scvVec(vk.IC.map((p) => bytes(g1Bytes(p))))),
  ]);
  // Proof map (keys a, b, c) — verify_proof takes pub_signals separately
  const proofScVal = (proof, order) => SDK.xdr.ScVal.scvMap([
    entry('a', bytes(g1Bytes(proof.pi_a))),
    entry('b', bytes(g2Bytes(proof.pi_b, order))),
    entry('c', bytes(g1Bytes(proof.pi_c))),
  ]);
  const pubVecScVal = (pub) => SDK.xdr.ScVal.scvVec(pub.map(u256ScVal));

  window.CovenantSerialize = { decToBe32, g1Bytes, g2Bytes, u256ScVal, proofSigScVal, payloadHalves, sorobanAuthPayload, vkScVal, proofScVal, pubVecScVal };
})();
