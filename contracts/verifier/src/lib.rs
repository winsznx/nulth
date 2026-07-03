//! Groth16 verifier over native BN254 (Protocol 25 "X-Ray" host functions).
//! Direct port of stellar/soroban-examples groth16_verifier (BLS12-381)
//! to the bn254 module, matching snarkjs/circom (bn128) proofs.
#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
    vec, Env, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Groth16Error {
    MalformedVerifyingKey = 0,
}

#[derive(Clone)]
#[contracttype]
pub struct VerificationKey {
    pub alpha: Bn254G1Affine,
    pub beta: Bn254G2Affine,
    pub gamma: Bn254G2Affine,
    pub delta: Bn254G2Affine,
    pub ic: Vec<Bn254G1Affine>,
}

#[derive(Clone)]
#[contracttype]
pub struct Proof {
    pub a: Bn254G1Affine,
    pub b: Bn254G2Affine,
    pub c: Bn254G1Affine,
}

#[contract]
pub struct Groth16Verifier;

#[contractimpl]
impl Groth16Verifier {
    pub fn verify_proof(
        env: Env,
        vk: VerificationKey,
        proof: Proof,
        pub_signals: Vec<Bn254Fr>,
    ) -> Result<bool, Groth16Error> {
        let bn = env.crypto().bn254();

        if pub_signals.len() + 1 != vk.ic.len() {
            return Err(Groth16Error::MalformedVerifyingKey);
        }
        // vk_x = ic[0] + sum(pub_signals[i] * ic[i+1])
        let mut vk_x = vk.ic.get(0).unwrap();
        for (s, v) in pub_signals.iter().zip(vk.ic.iter().skip(1)) {
            let prod = bn.g1_mul(&v, &s);
            vk_x = bn.g1_add(&vk_x, &prod);
        }

        // e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1
        let neg_a = -proof.a;
        let vp1 = vec![&env, neg_a, vk.alpha, vk_x, proof.c];
        let vp2 = vec![&env, proof.b, vk.beta, vk.gamma, vk.delta];

        Ok(bn.pairing_check(vp1, vp2))
    }
}
