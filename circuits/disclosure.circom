pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

// Tier-1 auditor disclosure (PRD §11):
//   Prove the hidden per-payment cap (committed in policy_commitment) is <= a public
//   regulatory_max, WITHOUT revealing the cap. The commitment opening binds the proof to
//   THIS treasury's real cap; only the true/false bit (cap <= max) is disclosed.
//   Reuses the deployed BN254 Groth16 verifier with a new vk.
//
// Public:  policy_commitment, regulatory_max
// Private: cap, salt
template CapDisclosure() {
    signal input policy_commitment;   // public
    signal input regulatory_max;      // public
    signal input cap;                 // private
    signal input salt;                // private

    // range-check to 100 bits (matches policy.circom; covers i128 stroop values)
    component rcap = Num2Bits(100); rcap.in <== cap;
    component rmax = Num2Bits(100); rmax.in <== regulatory_max;

    // commitment opens to (cap, salt) — same Poseidon(2) as the account's stored commitment
    component pc = Poseidon(2);
    pc.inputs[0] <== cap;
    pc.inputs[1] <== salt;
    pc.out === policy_commitment;

    // the disclosed property: cap <= regulatory_max
    component le = LessEqThan(100);
    le.in[0] <== cap;
    le.in[1] <== regulatory_max;
    le.out === 1;
}

component main {public [policy_commitment, regulatory_max]} = CapDisclosure();
