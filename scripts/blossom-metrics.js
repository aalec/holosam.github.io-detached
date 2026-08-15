#!/usr/bin/env node
// Blossom board generator metrics.
//
// Reports per board (mean ± std-dev across N boards):
//   • words/board, tiles/board, overlap rate
//   • word-length distribution
//   • overlap depth: inter-word and intra-word (consecutive reuse runs)
//
// And bank health across the same sample:
//   • word-sampling skew: how often each bank word is drawn
//   • boards to first repeated word, against the uniform-sampling ceiling
//   • start-letter RMS: chain start letters vs English first-letter frequency
//
// Per-board difficulty: scripts/blossom-difficulty.py, assets/blossom/DIFFICULTY.md.
//
// Definitions:
//   totalLetters = sum of all word lengths in the chain
//   junctions    = chain.length - 1  (shared letter between consecutive words)
//   effective    = totalLetters - junctions  (distinct letter positions)
//   totalTiles   = unique tiles on board
//   extraReuse   = effective - totalTiles  (non-junction tiles reused)
//   overlapRate  = extraReuse / effective
//
//   Overlap depth (intra / inter):
//     Per word, skip position 0 (the junction). A position is "inter" if its
//     tile also appears in any other word. "Intra" if the tile already appeared
//     at an earlier position within the same word. Depth = length of maximal
//     consecutive run of such positions.
//
// Usage:
//   node scripts/blossom-metrics.js        # 1000 boards
//   node scripts/blossom-metrics.js 500
'use strict';
const fs   = require('fs');
const path = require('path');

global.window = {};
eval(fs.readFileSync(path.join(__dirname, '../assets/blossom/words.js'), 'utf8'));
const Gen  = require('../assets/blossom/gen.js');

const N    = parseInt(process.argv[2] || '1000', 10);
const pool = window.BLOSSOM_GEN_WORDS;

// ── helpers ──────────────────────────────────────────────────────────────────

const mean = arr => arr.reduce((s, x) => s + x, 0) / arr.length;

function sd(arr, m) {
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

function fmt(arr, dp = 2) {
  const m = mean(arr);
  return `${m.toFixed(dp)} ± ${sd(arr, m).toFixed(dp)}`;
}

// ── overlap depth ─────────────────────────────────────────────────────────────

// Returns { intraCounts, interCounts } — depth → total runs across all boards.
// seq entries: { wordIdx, letterIdx, cellIdx }
// Word 0: all letterIdx present. Word k>0: only letterIdx >= 1 (junction omitted).
function overlapDepths(board) {
  const { seq, chain } = board;
  const numWords = chain.length;

  const wordCells = Array.from({ length: numWords }, () => []);
  for (const { wordIdx, letterIdx, cellIdx } of seq)
    wordCells[wordIdx].push({ li: letterIdx, c: cellIdx });
  for (const cells of wordCells) cells.sort((a, b) => a.li - b.li);

  const wordCellSets = wordCells.map(cells => new Set(cells.map(({ c }) => c)));
  const intraCounts = {}, interCounts = {};

  function recordRuns(flags, counts) {
    let run = 0;
    for (let i = 0; i <= flags.length; i++) {
      if (i < flags.length && flags[i]) { run++; }
      else if (run > 0) { counts[run] = (counts[run] || 0) + 1; run = 0; }
    }
  }

  for (let k = 0; k < numWords; k++) {
    const interFlags = [], intraFlags = [];
    const seenInWord = new Set();
    for (const { li, c } of wordCells[k]) {
      if (li === 0) continue; // skip junction
      const isIntra = seenInWord.has(c);
      seenInWord.add(c);
      let isInter = false;
      for (let j = 0; j < numWords; j++)
        if (j !== k && wordCellSets[j].has(c)) { isInter = true; break; }
      interFlags.push(isInter);
      intraFlags.push(isIntra);
    }
    recordRuns(interFlags, interCounts);
    recordRuns(intraFlags, intraCounts);
  }

  return { intraCounts, interCounts };
}

// ── collect ───────────────────────────────────────────────────────────────────

const words = [], tiles = [], rate = [];
const lengthCounts = {};
const allInter = {}, allIntra = {};
const useCount = new Map();     // bank word -> times drawn
const startLetter = {};         // first letter of each chain word -> count
let chainWordTotal = 0;
let boardsToRepeat = [];        // boards seen before a word repeats
let sinceRepeat = 0;
const seenSinceRepeat = new Set();

process.stderr.write(`Generating ${N} boards…\n`);
for (let i = 0; i < N; i++) {
  const board = Gen.generateBoard(i >>> 0, pool);
  const chain = board.chain;

  const totalLetters = chain.reduce((s, w) => s + w.length, 0);
  const eff        = totalLetters - (chain.length - 1);
  const extraReuse = eff - board.totalTiles;

  words.push(chain.length);
  tiles.push(board.totalTiles);
  rate.push(extraReuse / eff * 100);

  const seen = {};
  for (const w of chain) seen[w.length] = (seen[w.length] || 0) + 1;
  for (const len in seen) {
    if (!lengthCounts[len]) lengthCounts[len] = new Array(i).fill(0);
    lengthCounts[len].push(seen[len]);
  }
  for (const len in lengthCounts)
    if (lengthCounts[len].length <= i) lengthCounts[len].push(0);

  for (const w of chain) {
    useCount.set(w, (useCount.get(w) || 0) + 1);
    startLetter[w[0]] = (startLetter[w[0]] || 0) + 1;
    chainWordTotal++;
  }

  // Boards until a word recurs, restarting the count at each repeat.
  sinceRepeat++;
  let repeated = false;
  for (const w of chain) if (seenSinceRepeat.has(w)) { repeated = true; break; }
  if (repeated) {
    boardsToRepeat.push(sinceRepeat);
    sinceRepeat = 0;
    seenSinceRepeat.clear();
  }
  for (const w of chain) seenSinceRepeat.add(w);

  const { intraCounts, interCounts } = overlapDepths(board);
  for (const [d, c] of Object.entries(interCounts)) allInter[d] = (allInter[d] || 0) + c;
  for (const [d, c] of Object.entries(intraCounts)) allIntra[d] = (allIntra[d] || 0) + c;
}

// ── print ─────────────────────────────────────────────────────────────────────

const hr = '─'.repeat(50);
console.log(`\nBoards sampled: ${N}\n${hr}`);
console.log(`words/board:   ${fmt(words)}`);
console.log(`tiles/board:   ${fmt(tiles)}`);
console.log(`overlap rate:  ${fmt(rate, 1)}%`);

const allLens = Object.keys(lengthCounts).map(Number).sort((a, b) => a - b);
const padLen  = Math.max(...allLens.map(l => `${l}-letter`.length));
console.log(`\nwords per board by length:`);
for (const len of allLens)
  console.log(`  ${`${len}-letter`.padEnd(padLen)}  ${fmt(lengthCounts[len])}`);

console.log(`\noverlap depth (runs/board, junctions excluded):`);
function printDepths(label, counts) {
  const maxD = Object.keys(counts).map(Number).reduce((a, b) => Math.max(a, b), 0);
  let any = false;
  for (let d = 1; d <= maxD; d++) {
    const avg = (counts[d] || 0) / N;
    if (avg >= 0.01) { console.log(`    depth-${d}: ${avg.toFixed(3)}`); any = true; }
  }
  if (!any) console.log(`    (none)`);
}
console.log(`  inter-word (tile shared with another word):`);
printDepths('inter', allInter);
console.log(`  intra-word (tile revisited within same word):`);
printDepths('intra', allIntra);

// ── bank health ───────────────────────────────────────────────────────────────

console.log(`\n${hr}\nBank health (pool of ${pool.length} words)`);

const counts = pool.map(w => useCount.get(w) || 0);
const bands = [[101, Infinity], [31, 100], [10, 30], [4, 9], [1, 3], [0, 0]];
const label = { '101': '> 100', '31': '31-100', '10': '10-30', '4': '4-9', '1': '1-3', '0': 'never used' };
console.log(`\nword-sampling skew (times drawn over ${N} boards):`);
for (const [lo, hi] of bands) {
  const n = counts.filter(c => c >= lo && c <= hi).length;
  console.log(`  ${label[String(lo)].padEnd(11)} ${String(n).padStart(5)}  (${(100 * n / pool.length).toFixed(1)}%)`);
}
let topWord = null, topN = 0;
for (const [w, c] of useCount) if (c > topN) { topN = c; topWord = w; }
console.log(`  most drawn:  ${topWord} (${topN}x)`);

// Birthday bound: first collision near sqrt(pi*N/2) draws, over k draws/board.
const wpb = mean(words);
const ceiling = Math.sqrt(Math.PI * pool.length / 2) / wpb;
if (boardsToRepeat.length) {
  const m = mean(boardsToRepeat);
  console.log(`\nboards to first repeat: ${fmt(boardsToRepeat)}`);
  console.log(`  uniform-sampling ceiling: ${ceiling.toFixed(2)}  (${(100 * m / ceiling).toFixed(0)}% of it)`);
}

// Chain words start on the previous word's last letter, so the achievable
// distribution is constrained. This measures the gap to English.
const eng = Gen.ENGLISH_FIRST_LETTER_PCT;
let sumSq = 0, nL = 0;
const rows = [];
for (const l of Object.keys(eng).sort()) {
  const got = 100 * (startLetter[l] || 0) / chainWordTotal;
  const want = eng[l];
  sumSq += ((got - want) / want) ** 2;
  nL++;
  rows.push([l, want, got]);
}
console.log(`\nstart-letter RMS vs English: ${Math.sqrt(sumSq / nL).toFixed(3)}`);
const worst = rows.map(([l, want, got]) => [l, want, got, Math.abs(got - want) / want])
  .sort((a, b) => b[3] - a[3]).slice(0, 5);
console.log(`  furthest off:  ` + worst.map(([l, want, got]) =>
  `${l} ${got.toFixed(1)}% vs ${want.toFixed(1)}%`).join(',  '));
