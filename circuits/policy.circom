pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

// ZK payment policy check (P1 hardened):
//   amount <= cap                          (cap private)
//   dest is member of Poseidon Merkle allowlist (membership path private)
//   prover knows (cap, salt) s.t. Poseidon(cap, salt) == policy_commitment
//   sigpayload_hi/lo bind the proof to ONE Soroban invocation (replay defense, §8)
// Public: amount, dest, policy_commitment, allowlist_root, sigpayload_hi, sigpayload_lo
// Private: cap, salt, merkle path + index bits
//
// DEPTH=16 -> up to 65,536 allowlisted destinations (production).

template MerkleMembership(DEPTH) {
    signal input leaf;
    signal input path[DEPTH];
    signal input index_bits[DEPTH]; // 0 = leaf is left, 1 = leaf is right
    signal output root;

    component h[DEPTH];
    signal cur[DEPTH + 1];
    cur[0] <== leaf;
    signal l[DEPTH];
    signal r[DEPTH];
    for (var i = 0; i < DEPTH; i++) {
        index_bits[i] * (1 - index_bits[i]) === 0; // booleanity
        l[i] <== cur[i] + index_bits[i] * (path[i] - cur[i]);
        r[i] <== path[i] + index_bits[i] * (cur[i] - path[i]);
        h[i] = Poseidon(2);
        h[i].inputs[0] <== l[i];
        h[i].inputs[1] <== r[i];
        cur[i + 1] <== h[i].out;
    }
    root <== cur[DEPTH];
}

template PaymentPolicy(DEPTH) {
    // public
    signal input amount;
    signal input dest;
    signal input policy_commitment;
    signal input allowlist_root;
    signal input sigpayload_hi;       // high 128 bits of Soroban signature_payload
    signal input sigpayload_lo;       // low  128 bits of Soroban signature_payload
    // private
    signal input cap;
    signal input salt;
    signal input path[DEPTH];
    signal input index_bits[DEPTH];

    // range-check amount and cap to 100 bits (covers i128 stroop amounts in practice)
    component ra = Num2Bits(100); ra.in <== amount;
    component rc = Num2Bits(100); rc.in <== cap;

    // amount <= cap
    component le = LessEqThan(100);
    le.in[0] <== amount;
    le.in[1] <== cap;
    le.out === 1;

    // policy commitment opens to (cap, salt)
    component pc = Poseidon(2);
    pc.inputs[0] <== cap;
    pc.inputs[1] <== salt;
    pc.out === policy_commitment;

    // dest in allowlist
    component mm = MerkleMembership(DEPTH);
    mm.leaf <== dest;
    for (var i = 0; i < DEPTH; i++) {
        mm.path[i] <== path[i];
        mm.index_bits[i] <== index_bits[i];
    }
    mm.root === allowlist_root;

    // Bind the invocation: genuinely constrain both halves (range-check to 128 bits)
    // so circom cannot drop them. Groth16 binds these public signals to the proof,
    // making it non-transferable to any other Soroban signature_payload.
    component rhi = Num2Bits(128); rhi.in <== sigpayload_hi;
    component rlo = Num2Bits(128); rlo.in <== sigpayload_lo;
}

component main {public [amount, dest, policy_commitment, allowlist_root, sigpayload_hi, sigpayload_lo]} = PaymentPolicy(16);
