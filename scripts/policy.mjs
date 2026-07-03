// Compute the hidden policy: commitment + Merkle allowlist root + membership path,
// using circomlibjs Poseidon (matches circomlib poseidon.circom in policy.circom).
import { buildPoseidon } from 'circomlibjs';

let _p;
async function poseidon2() {
  if (!_p) { const p = await buildPoseidon(); _p = { fn: p, F: p.F }; }
  return _p;
}

// Poseidon(2)(cap, salt) -> commitment, without rebuilding the tree (used by wrong_policy).
export async function commitmentOf(cap, salt) {
  const { fn, F } = await poseidon2();
  return F.toObject(fn([BigInt(cap), BigInt(salt)])).toString();
}

export async function computePolicy({ cap, salt, destLeaf, leafCount = 65536, destIndex = 0 }) {
  const { fn, F } = await poseidon2();
  const H = (a, b) => F.toObject(fn([a, b]));
  const leaves = Array.from({ length: leafCount }, (_, i) => (i === destIndex ? BigInt(destLeaf) : BigInt(1000 + i)));

  let level = leaves.slice();
  const levels = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(H(level[i], level[i + 1]));
    levels.push(next);
    level = next;
  }
  const root = levels[levels.length - 1][0];

  const depth = Math.log2(leafCount);
  let idx = destIndex;
  const path = [], index_bits = [];
  for (let l = 0; l < depth; l++) {
    const sib = idx ^ 1;
    path.push(levels[l][sib].toString());
    index_bits.push((idx & 1).toString());
    idx >>= 1;
  }

  const commitment = H(BigInt(cap), BigInt(salt));
  return {
    commitment: commitment.toString(),
    root: root.toString(),
    path,
    index_bits,
    leaves: leaves.map((x) => x.toString()),
  };
}
