// P1 setup: choose the hidden policy, persist the secret, emit the public
// commitment/root and the CLI-shaped vk for the __constructor deploy.
import fs from 'fs';
import { computePolicy } from './policy.mjs';
import { vkCliHex } from './lib.mjs';

const DEST = process.env.DEST;                                   // dest_field(payee), decimal
const CAP = process.env.CAP || '1000000000';                    // 100 USDC private cap
const SALT = process.env.SALT || '88553311227744660099887766554433221100';
if (!DEST) { console.error('DEST env required'); process.exit(1); }

const t0 = Date.now();
const pol = await computePolicy({ cap: CAP, salt: SALT, destLeaf: DEST }); // DEPTH-16: real 65,536-leaf tree
const treeMs = Date.now() - t0;
// persist path/index_bits/root/commitment so pay/fixture never rebuild the tree (clean proving timings)
const secret = { cap: CAP, salt: SALT, destLeaf: DEST, depth: 16, leafCount: 65536, commitment: pol.commitment, root: pol.root, path: pol.path, index_bits: pol.index_bits };
fs.writeFileSync('/Users/mac/covenant/build/policy_secret.json', JSON.stringify(secret, null, 1));
console.log('TREE_BUILD_MS=' + treeMs + ' (65,536-leaf Poseidon-Merkle, depth 16)');

const vk = JSON.parse(fs.readFileSync('/Users/mac/covenant/circuits/build/verification_key.json'));
fs.writeFileSync('/Users/mac/covenant/build/vk_cli.json', JSON.stringify(vkCliHex(vk, 'c1c0')));

console.log('COMMITMENT=' + pol.commitment);
console.log('ROOT=' + pol.root);
