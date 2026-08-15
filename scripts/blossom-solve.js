#!/usr/bin/env node
// Print today's Blossom board + the generator's intended word chain.
// Uses the same generator as the browser so output matches the live game.
//
// --json emits the board as JSON, including `seq` (the generator's placement),
// for scripts/blossom-difficulty.py. Generation is not ported elsewhere.
//
// Usage:
//   node scripts/blossom-solve.js              # today
//   node scripts/blossom-solve.js 2026-12-25   # specific date
//   node scripts/blossom-solve.js --json | python3 scripts/blossom-difficulty.py
//   node scripts/blossom-solve.js --json --seeds 0-99 > boards.json
const fs = require('fs');
const path = require('path');

// The words file uses `window.X = ...` in the browser; stub it for Node.
global.window = {};
eval(fs.readFileSync(path.join(__dirname, '../assets/blossom/words.js'), 'utf8'));

const Gen = require('../assets/blossom/gen.js');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const seedArg = (argv[argv.indexOf('--seeds') + 1] || '').match(/^(\d+)-(\d+)$/);
const arg = argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

function boardToJson(board, seed) {
  const tiles = {};
  for (const [cell, letter] of board.tiles) tiles[cell] = letter;
  return {
    seed,
    chain: board.chain,
    tiles,
    start: board.start,
    targetWords: board.targetWords,
    totalTiles: board.totalTiles,
    seq: board.seq,
  };
}

if (seedArg) {
  const lo = parseInt(seedArg[1], 10);
  const hi = parseInt(seedArg[2], 10);
  const out = [];
  for (let s = lo; s <= hi; s++) {
    out.push(boardToJson(Gen.generateBoard(s >>> 0, window.BLOSSOM_GEN_WORDS), s));
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

const date = arg
  ? new Date(arg + 'T00:00:00')
  : new Date();
if (isNaN(date)) {
  console.error(`Bad date: ${arg}. Use YYYY-MM-DD.`);
  process.exit(1);
}

const seed = Gen.seedForDate(date);
const board = Gen.generateBoard(seed, window.BLOSSOM_GEN_WORDS);

if (asJson) {
  console.log(JSON.stringify([boardToJson(board, seed)]));
  process.exit(0);
}

console.log(`Blossom ${Gen.dateKey(date)}`);
console.log(`  target: ${board.targetWords} words`);
console.log(`  tiles:  ${board.totalTiles}`);
console.log(`  chain:  ${board.chain.join(' → ').toUpperCase()}`);
console.log();

// ASCII grid (rows offset by half-cell each to mimic the hex offset)
let minR = Infinity, minC = Infinity, maxR = -Infinity, maxC = -Infinity;
for (const i of board.tiles.keys()) {
  const [r, c] = Gen.toRC(i);
  if (r < minR) minR = r;
  if (r > maxR) maxR = r;
  if (c < minC) minC = c;
  if (c > maxC) maxC = c;
}
const startRC = Gen.toRC(board.start);
for (let r = minR; r <= maxR; r++) {
  let line = ' '.repeat((r - minR) * 2);
  for (let c = minC; c <= maxC; c++) {
    const i = Gen.idx(r, c);
    const l = board.tiles.get(i);
    if (!l) {
      line += '·   ';
    } else if (r === startRC[0] && c === startRC[1]) {
      line += `[${l.toUpperCase()}]`;
    } else {
      line += ` ${l.toUpperCase()}  `;
    }
  }
  console.log(line.replace(/\s+$/, ''));
}
console.log();
console.log('[X] = starting tile');
