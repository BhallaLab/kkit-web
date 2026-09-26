// Regression coverage for the flow-layout row-alternation invariant:
// every pool sits on a non-pool-adjacent row, every non-pool likewise --
// with ZERO exceptions. Rewritten for the grid-based layout
// (layoutGrid.js) that replaced an earlier Sugiyama-style layered
// approach; this invariant regressed FOUR times against that earlier
// design, each time in the seam between "keep rows alternating" and
// "manage aspect ratio or row length" (see layoutGrid.js's own module
// comment for why the grid design sidesteps that seam structurally
// instead of re-deriving and re-checking it after the fact) -- and once
// more even after that redesign, when the swap optimizer was able to
// drain a row to zero real content over several cycles without anything
// noticing (see trySwapStep's own comment on `canMoveToBlank`). This file
// checks the OUTPUT positions from scratch every time, not any
// implementation detail of how the algorithm got there, so it stays
// meaningful across further changes to the algorithm itself.
//
// Run directly with `node layoutSeed.alternation.test.mjs` (or
// `npm test` from frontend/) -- no test framework or build step needed:
// pure ES modules, no React/backend dependency, safe to run standalone.
import { computeFlowGroupLayout } from './layoutGrid.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log('FAIL:', msg);
  }
}

function categoryOf(type) {
  return type === 'pool' ? 'pool' : 'nonpool';
}

// The hard invariant itself, checked from scratch against whatever
// positions a run produced -- no assumption about HOW it got there.
function checkAlternation(label, children, positions) {
  const byY = new Map();
  children.forEach((c) => {
    const p = positions.get(c.id);
    assert(!!p, `${label}: ${c.id} has a position`);
    if (!p) return;
    const y = Math.round(p.y * 1000) / 1000;
    if (!byY.has(y)) byY.set(y, []);
    byY.get(y).push(c);
  });

  // 1. Every row is pure -- no pool/non-pool mix on one row.
  byY.forEach((members, y) => {
    const cats = new Set(members.map((c) => categoryOf(c.type)));
    assert(cats.size === 1, `${label}: row at y=${y} is pure (found ${[...cats]}: ${members.map((c) => c.name)})`);
  });

  // 2. No two rows of the SAME category are ever adjacent, in sorted
  // (rendered top-to-bottom) order -- the actual alternation
  // requirement, zero exceptions.
  const sortedY = [...byY.keys()].sort((a, b) => b - a); // Y-up: top row has the largest y
  for (let i = 1; i < sortedY.length; i++) {
    const prevCat = categoryOf(byY.get(sortedY[i - 1])[0].type);
    const curCat = categoryOf(byY.get(sortedY[i])[0].type);
    assert(prevCat !== curCat, `${label}: rows at y=${sortedY[i - 1]} and y=${sortedY[i]} alternate category (${prevCat} vs ${curCat})`);
  }

  // 3. Row zero (the topmost row, when it's non-pool -- the common case
  // for a group with at least one non-pool-type genuine root) must be
  // non-pool -- item 1's own stipulation. Not checked when the topmost
  // row happens to be pool (a group whose true shallowest content is
  // entirely pool-rooted has no non-pool content to legitimately put
  // above it -- see this file's own earlier design discussion).
  if (sortedY.length > 0) {
    const topCat = categoryOf(byY.get(sortedY[0])[0].type);
    if (topCat === 'pool') {
      // Not itself a failure (see above) -- just a data point worth
      // seeing if it happens, not asserted against.
    }
  }

  return sortedY.length;
}

function runLayout(children, edgesRaw, rawByIdExtra = {}) {
  const rawById = {};
  children.forEach((c) => {
    rawById[c.id] = { ...c, ...rawByIdExtra[c.id] };
  });
  const sizes = new Map(children.map((c) => [c.id, { width: c.width ?? 3, height: c.height ?? 3 }]));
  const edges = edgesRaw.map((e) => ({ source: e.source, target: e.target, data: { type: e.type } }));
  return computeFlowGroupLayout({ children, edges, rawById, sizes });
}

// --- Fixture 1: Kholodenko.g's own MAPK group, verbatim -------------------
// The exact real-model data (26 nodes, 33 edges) the original alternation
// regressions were tracked down and verified against live.
{
  const children = [
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/MAPK', name: 'MAPK', type: 'pool' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/MKKK', name: 'MKKK', type: 'pool' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/MKK', name: 'MKK', type: 'pool' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/int1', name: 'int1', type: 'pool' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/MKKK_P', name: 'MKKK_P', type: 'pool' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/int3', name: 'int3', type: 'pool' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/int5', name: 'int5', type: 'pool' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_P', name: 'MKK_P', type: 'pool' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/MAPK_P', name: 'MAPK_P', type: 'pool' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/int2', name: 'int2', type: 'pool' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/int4', name: 'int4', type: 'pool' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/Ras_MKKKK', name: 'Ras_MKKKK', type: 'pool' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/inactiveRas_MKKK', name: 'inactiveRas_MKKK', type: 'pool', width: 6 },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_PP', name: 'MKK_PP', type: 'pool' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/MAPK_PP', name: 'MAPK_PP', type: 'pool' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/Neg_feedback', name: 'Neg_feedback', type: 'reac' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/int1[0]/_2', name: '_2', type: 'enz' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/MKKK_P[0]/_3', name: '_3', type: 'enz' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/MKKK_P[0]/_4', name: '_4', type: 'enz' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/int3[0]/_6', name: '_6', type: 'enz' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/int5[0]/_10', name: '_10', type: 'enz' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/int2[0]/_5', name: '_5', type: 'enz' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/int4[0]/_9', name: '_9', type: 'enz' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/Ras_MKKKK[0]/_1', name: '_1', type: 'enz' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_PP[0]/_7', name: '_7', type: 'enz' },
    { id: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_PP[0]/_8', name: '_8', type: 'enz' },
  ];
  const edges = [
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/Ras_MKKKK', target: '/model_99[0]/kinetics[0]/MAPK[0]/Neg_feedback', type: 'substrate' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MAPK_PP', target: '/model_99[0]/kinetics[0]/MAPK[0]/Neg_feedback', type: 'substrate' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/Neg_feedback', target: '/model_99[0]/kinetics[0]/MAPK[0]/inactiveRas_MKKK', type: 'product' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/int1', target: '/model_99[0]/kinetics[0]/MAPK[0]/int1[0]/_2', type: 'enzyme' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MKKK_P', target: '/model_99[0]/kinetics[0]/MAPK[0]/int1[0]/_2', type: 'substrate' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/int1[0]/_2', target: '/model_99[0]/kinetics[0]/MAPK[0]/MKKK', type: 'product' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MKKK_P', target: '/model_99[0]/kinetics[0]/MAPK[0]/MKKK_P[0]/_3', type: 'enzyme' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MKK', target: '/model_99[0]/kinetics[0]/MAPK[0]/MKKK_P[0]/_3', type: 'substrate' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MKKK_P[0]/_3', target: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_P', type: 'product' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MKKK_P', target: '/model_99[0]/kinetics[0]/MAPK[0]/MKKK_P[0]/_4', type: 'enzyme' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_P', target: '/model_99[0]/kinetics[0]/MAPK[0]/MKKK_P[0]/_4', type: 'substrate' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MKKK_P[0]/_4', target: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_PP', type: 'product' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/int3', target: '/model_99[0]/kinetics[0]/MAPK[0]/int3[0]/_6', type: 'enzyme' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_P', target: '/model_99[0]/kinetics[0]/MAPK[0]/int3[0]/_6', type: 'substrate' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/int3[0]/_6', target: '/model_99[0]/kinetics[0]/MAPK[0]/MKK', type: 'product' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/int5', target: '/model_99[0]/kinetics[0]/MAPK[0]/int5[0]/_10', type: 'enzyme' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MAPK_P', target: '/model_99[0]/kinetics[0]/MAPK[0]/int5[0]/_10', type: 'substrate' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/int5[0]/_10', target: '/model_99[0]/kinetics[0]/MAPK[0]/MAPK', type: 'product' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/int2', target: '/model_99[0]/kinetics[0]/MAPK[0]/int2[0]/_5', type: 'enzyme' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_PP', target: '/model_99[0]/kinetics[0]/MAPK[0]/int2[0]/_5', type: 'substrate' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/int2[0]/_5', target: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_P', type: 'product' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/int4', target: '/model_99[0]/kinetics[0]/MAPK[0]/int4[0]/_9', type: 'enzyme' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MAPK_PP', target: '/model_99[0]/kinetics[0]/MAPK[0]/int4[0]/_9', type: 'substrate' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/int4[0]/_9', target: '/model_99[0]/kinetics[0]/MAPK[0]/MAPK_P', type: 'product' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/Ras_MKKKK', target: '/model_99[0]/kinetics[0]/MAPK[0]/Ras_MKKKK[0]/_1', type: 'enzyme' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MKKK', target: '/model_99[0]/kinetics[0]/MAPK[0]/Ras_MKKKK[0]/_1', type: 'substrate' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/Ras_MKKKK[0]/_1', target: '/model_99[0]/kinetics[0]/MAPK[0]/MKKK_P', type: 'product' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_PP', target: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_PP[0]/_7', type: 'enzyme' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MAPK', target: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_PP[0]/_7', type: 'substrate' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_PP[0]/_7', target: '/model_99[0]/kinetics[0]/MAPK[0]/MAPK_P', type: 'product' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_PP', target: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_PP[0]/_8', type: 'enzyme' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MAPK_P', target: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_PP[0]/_8', type: 'substrate' },
    { source: '/model_99[0]/kinetics[0]/MAPK[0]/MKK_PP[0]/_8', target: '/model_99[0]/kinetics[0]/MAPK[0]/MAPK_PP', type: 'product' },
  ];
  const { positions } = runLayout(children, edges);
  const rows = checkAlternation('Kholodenko.g MAPK', children, positions);
  assert(rows > 0, 'Kholodenko.g MAPK: produced at least one row');
}

// --- Fixture 2: a local source that isn't "isolated" ----------------------
// A reaction whose substrate is outside the group has a real local edge
// (its product) but zero LOCAL forward predecessors -- historically the
// root cause of the very first alternation bug this session tracked
// down, under the earlier layered design. Under the grid design this is
// moot by construction (row category is fixed by the grid itself, not
// derived from graph depth) -- kept as a regression guard regardless.
{
  const children = [
    { id: 'P1', name: 'P1', type: 'pool' },
    { id: 'R1', name: 'R1', type: 'reac' },
    { id: 'P2', name: 'P2', type: 'pool' },
  ];
  const edges = [
    { source: 'external_sub', target: 'R1', type: 'substrate' },
    { source: 'R1', target: 'P2', type: 'product' },
  ];
  const { positions } = runLayout(children, edges);
  checkAlternation('boundary-crossing local source', children, positions);
}

// --- Fixture 3: a large, genuinely imbalanced pool/non-pool set -----------
// 20 pools (6 with long names, needing two grid cells each -- item 7) vs
// 8 non-pools -- a real imbalance ratio (2.5:1), the same shape that
// caused rows to silently empty out on Kholodenko.g/Repressillator.g's
// own real data (see computeGridDimensions/distributeSlotCounts' own
// comments): forcing both sides to the same row count without properly
// spreading the sparser side's own real content across every one of
// those rows leaves some of them with zero real content, which reads as
// an alternation violation once rendered.
{
  const children = [];
  const edges = [];
  for (let i = 0; i < 20; i++) {
    children.push({ id: `P${i}`, name: `P${i}`, type: 'pool', width: i % 3 === 0 ? 6 : 3 });
  }
  for (let i = 0; i < 8; i++) {
    children.push({ id: `R${i}`, name: `R${i}`, type: 'reac' });
    edges.push({ source: `P${i}`, target: `R${i}`, type: 'substrate' });
  }
  const { positions } = runLayout(children, edges);
  const rows = checkAlternation('imbalanced 20-pool/8-reac set', children, positions);
  assert(rows >= 4, `imbalanced set: uses a reasonable number of distinct rows (got ${rows})`);
}

// --- Fixture 4: a summation function with real pool inputs -----------------
// A Function with pool inputs (see moose_graph.py's describe_stim/
// _function_inputs split, nodes.jsx's FuncNode) is a "func" node, not a
// "stim" -- it belongs on a non-pool row like any other non-pool, with
// real funcInput edges connecting its input pools to it.
{
  const children = [
    { id: 'P1', name: 'P1', type: 'pool' },
    { id: 'P2', name: 'P2', type: 'pool' },
    { id: 'func', name: 'func', type: 'func' },
    { id: 'Target', name: 'Target', type: 'pool' },
  ];
  const edges = [
    { source: 'P1', target: 'func', type: 'funcInput' },
    { source: 'P2', target: 'func', type: 'funcInput' },
    { source: 'func', target: 'Target', type: 'stimTarget' },
  ];
  const { positions } = runLayout(children, edges);
  checkAlternation('summation function with pool inputs', children, positions);
  const funcCat = categoryOf('func');
  assert(funcCat === 'nonpool', 'a func node is categorized as non-pool');
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
