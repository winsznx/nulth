// Build a valid policy.circom witness input for ONE payment, and emit the
// public policy_commitment + allowlist_root the account is initialized with.
//
// We choose the (private) policy: a spend cap, a salt, and a 16-slot Poseidon
// Merkle allowlist with the payee's dest_field at index 0. The commitment and
// root are the only public footprint; cap/salt/allowlist never leave here.
import { buildPoseidon } from 'circomlibjs';
import fs from 'fs';

const DEST   = process.env.DEST;                       // dest_field(payee), decimal
const AMOUNT = process.env.AMOUNT || '10000000';       // 1.0 USDC (7 decimals)
const CAP    = process.env.CAP    || '1000000000';     // 100 USDC private cap
const SALT   = process.env.SALT   || '88553311227744660099887766554433221100';
const OUT    = process.env.OUT    || '/Users/mac/covenant/circuits/build/input.json';
if (!DEST) { console.error('DEST env required'); process.exit(1); }

const poseidon = await buildPoseidon();
const F = poseidon.F;
const H2 = (a, b) => F.toObject(poseidon([a, b]));     // Poseidon(2) -> BigInt

// 16-leaf allowlist, payee at index 0, distinct dummies elsewhere
const leaves = Array.from({ length: 16 }, (_, i) => (i === 0 ? BigInt(DEST) : BigInt(1000 + i)));

// build the binary Poseidon(2) Merkle tree, keep every level
let level = leaves.slice();
const levels = [level];
while (level.length > 1) {
  const next = [];
  for (let i = 0; i < level.length; i += 2) next.push(H2(level[i], level[i + 1]));
  levels.push(next);
  level = next;
}
const root = levels[levels.length - 1][0];

// membership path + index bits for leaf 0
let idx = 0;
const path = [], index_bits = [];
for (let l = 0; l < 4; l++) {
  const sib = idx ^ 1;
  path.push(levels[l][sib].toString());
  index_bits.push((idx & 1).toString());
  idx >>= 1;
}

const commitment = H2(BigInt(CAP), BigInt(SALT));

const input = {
  amount: AMOUNT,
  dest: DEST,
  policy_commitment: commitment.toString(),
  allowlist_root: root.toString(),
  cap: CAP,
  salt: SALT,
  path,
  index_bits,
};
fs.writeFileSync(OUT, JSON.stringify(input, null, 1));
fs.writeFileSync(OUT.replace(/input\.json$/, 'policy_public.json'),
  JSON.stringify({ amount: AMOUNT, dest: DEST, policy_commitment: commitment.toString(), allowlist_root: root.toString() }, null, 1));
console.log(JSON.stringify({ amount: AMOUNT, dest: DEST, policy_commitment: commitment.toString(), allowlist_root: root.toString() }, null, 1));
