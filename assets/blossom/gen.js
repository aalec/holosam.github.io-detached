// Shared board generator: works in both browser (window.BlossomGen) and Node
// (module.exports), so the daily board logic is reusable by the CLI scripts.
(function (root) {
  function mulberry32(seed) {
    return function () {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function dateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function seedForDate(d) {
    const epoch = new Date(2026, 0, 1);
    const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = Math.floor((local - epoch) / 86400000);
    let h = (day + 0x9e3779b9) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  // Offset coords on a notional 12x12 grid. Adjacency: same row ±1, row±1 with
  // a col shift that keeps pointy-top hexes aligned.
  const GRID = 12;
  const idx = (r, c) => r * GRID + c;
  const toRC = (i) => [Math.floor(i / GRID), i % GRID];

  function neighbors(i) {
    const [r, c] = toRC(i);
    return [
      [r, c - 1],
      [r, c + 1],
      [r - 1, c],
      [r - 1, c + 1],
      [r + 1, c - 1],
      [r + 1, c],
    ]
      .filter(([rr, cc]) => rr >= 0 && rr < GRID && cc >= 0 && cc < GRID)
      .map(([rr, cc]) => idx(rr, cc));
  }

  function isAdjacent(a, b) {
    return neighbors(a).includes(b);
  }

  // Distance on this offset hex grid, used as a placement tiebreaker to keep the
  // blossom hugging the center. https://stackoverflow.com/questions/5084801
  function hexDistance(a, b) {
    const [ar, ac] = toRC(a);
    const [br, bc] = toRC(b);
    const dr = br - ar;
    const dc = bc - ac;
    return (dr < 0 && dc < 0) || (dr >= 0 && dc >= 0)
      ? Math.abs(dr + dc)
      : Math.max(Math.abs(dr), Math.abs(dc));
  }

  // Order `items` by weighted sampling without replacement, so the builder tries
  // its preferred word first and falls back through the rest if placement
  // dead-ends.
  function weightedShuffle(items, weights, rng) {
    const pool = items.map((it, i) => ({ it, w: weights[i] }));
    let total = pool.reduce((s, x) => s + x.w, 0);
    const out = [];
    while (pool.length) {
      let r = rng() * total;
      let k = 0;
      for (; k < pool.length - 1; k++) {
        r -= pool[k].w;
        if (r <= 0) break;
      }
      out.push(pool[k].it);
      total -= pool[k].w;
      pool.splice(k, 1);
    }
    return out;
  }

  // How often each letter starts an English word — the target shape for a
  // chain's start letters (see corrFactor below). Percent of SCOWL-60 US
  // entries, lengths 4-8, N=40,769. Reproduce with:
  //   awk 'f && /^[a-z]+$/ && length>=4 && length<=8 {c[substr($0,1,1)]++; n++}
  //        /^---$/{f=1} END{for (l in c) printf "%s %.2f\n", l, 100*c[l]/n}' \
  //     assets/blossom/scowl-60.txt | sort
  //
  // Hardcoded on purpose: derived at build time from BLOSSOM_WORDS, one
  // validate-only word would shift every corrFactor and silently regenerate
  // every future board. Editing these numbers changes all future boards.
  const ENGLISH_FIRST_LETTER_PCT = {
    a: 4.75, b: 7.23, c: 8.91, d: 5.91, e: 3.25, f: 4.97, g: 4.05,
    h: 3.85, i: 2.10, j: 1.24, k: 1.00, l: 3.77, m: 5.12, n: 1.90,
    o: 2.14, p: 7.36, q: 0.53, r: 5.98, s: 12.52, t: 5.81, u: 1.80,
    v: 1.59, w: 3.43, x: 0.08, y: 0.42, z: 0.28,
  };

  function generateBoard(seed, genPool, options) {
    const opts = options || {};
    const targetTiles = opts.targetTiles || 21;
    const minTiles = opts.minTiles || 15;
    const maxWords = opts.maxWords || 8;
    // Bias toward word lengths not yet used in this board: each prior use of a
    // length multiplies its weight by (1+alpha)^-count.
    const lengthAlpha = opts.lengthAlpha != null ? opts.lengthAlpha : 0.6;
    // Intrinsic per-length preference (default 1), damping the short/long
    // extremes so they sprinkle in without dominating the mix.
    const lengthWeight = opts.lengthWeight || { 4: 1.1, 5: 0.9, 7: 1.15, 8: 0.5 };
    // Localized-overlap weighting: reward letters that can reuse a tile near the
    // junction, weighting the word's earliest letters most (the ones the greedy
    // placer can actually fold back onto an existing tile).
    const localRadius = opts.localRadius != null ? opts.localRadius : 2;
    const overlapDecay = opts.overlapDecay != null ? opts.overlapDecay : 0.8;
    // Floor weight for words with no local overlap.
    const overlapFloor = opts.overlapFloor != null ? opts.overlapFloor : 0.3;
    // Clamps corrFactor (below) to [1/cap, cap].
    const corrFactorCap = opts.corrFactorCap != null ? opts.corrFactorCap : 3;
    const targetLetters = targetTiles * 1.5;
    // Runaway guard: cap total placement attempts before reseeding. Normal
    // generation never approaches this.
    let budget = opts.budget || 20000;

    const genByFirst = {};
    for (const w of genPool) (genByFirst[w[0]] ||= []).push(w);

    // Each word after the first STARTS on the previous word's last letter, so
    // the chain's start letters are just the letters we pick words to END on.
    // Uncorrected that follows how English words end (e/y/t/n/r/s), not how
    // they start. So weight each candidate by
    //
    //   corrFactor[last letter] = target share / our pool's supply share
    //
    // target = ENGLISH_FIRST_LETTER_PCT (opts.letterFreq overrides, for the
    // metrics scripts); supply = how often the pool offers that ending. Both
    // normalized, so corrFactorCap means the same thing either way.
    const poolLastCount = {};
    for (const w of genPool) {
      poolLastCount[w[w.length - 1]] = (poolLastCount[w[w.length - 1]] || 0) + 1;
    }
    const targetCount = opts.letterFreq || ENGLISH_FIRST_LETTER_PCT;
    let targetTotal = 0, supplyTotal = 0;
    for (const l in targetCount) targetTotal += targetCount[l];
    for (const l in poolLastCount) supplyTotal += poolLastCount[l];
    const corrFactor = {};
    for (const l in poolLastCount) {
      const target = (targetCount[l] || 0) / targetTotal;
      const supply = poolLastCount[l] / supplyTotal;
      const ratio = (target + 1e-9) / (supply + 1e-9);
      corrFactor[l] = Math.min(Math.max(ratio, 1 / corrFactorCap), corrFactorCap);
    }

    // Every decision below — seed word, each subsequent word, every tile
    // placement — draws from this one rng stream, so the board is byte-identical
    // only for an identical seed (the same date). Keep it that way: never key a
    // decision off word identity; always pull from this rng.
    const rng = mulberry32(seed);
    const start = idx(Math.floor(GRID / 2), Math.floor(GRID / 2));

    function shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    // Place `letter` adjacent to prevCell (or at center if null). Reuse an
    // adjacent tile already holding it; otherwise take the empty neighbor most
    // surrounded by filled tiles, ties broken toward center to stay compact.
    // Returns the cell, or null if boxed in — the caller's signal to backtrack.
    function placeLetter(tiles, letter, prevCell) {
      if (prevCell === null) {
        tiles.set(start, letter);
        return start;
      }
      const nbrs = shuffle(neighbors(prevCell));
      for (const n of nbrs) {
        if (tiles.get(n) === letter) return n;
      }
      let best = -1;
      let bestScore = -1;
      let bestDist = Infinity;
      for (const n of nbrs) {
        if (tiles.has(n)) continue;
        const filledNeighbors = neighbors(n).filter((x) => tiles.has(x)).length;
        const dist = hexDistance(n, start);
        if (
          filledNeighbors > bestScore ||
          (filledNeighbors === bestScore && dist < bestDist)
        ) {
          bestScore = filledNeighbors;
          bestDist = dist;
          best = n;
        }
      }
      if (best < 0) return null;
      tiles.set(best, letter);
      return best;
    }

    // Mutable build state, reset per seed-word attempt below.
    let tiles, seq, chain, used, lengthCounts, allLetters;

    // Lay `word` onto the board. The first letter is the shared tile (placed by
    // the previous word, or the center for the first word), so letters are placed
    // from index 1. Returns the cells newly added (for rollback) and whether it
    // succeeded.
    function placeWord(word, isFirst) {
      const added = [];
      let prev;
      if (isFirst) {
        const c = placeLetter(tiles, word[0], null);
        added.push(c);
        seq.push({ wordIdx: chain.length, letterIdx: 0, cellIdx: c });
        prev = c;
      } else {
        prev = seq[seq.length - 1].cellIdx;
      }
      for (let li = 1; li < word.length; li++) {
        const before = tiles.size;
        const c = placeLetter(tiles, word[li], prev);
        if (c === null) return { ok: false, added };
        if (tiles.size > before) added.push(c);
        seq.push({ wordIdx: chain.length, letterIdx: li, cellIdx: c });
        prev = c;
      }
      return { ok: true, added };
    }

    // Recursively append words to the chain, backtracking on dead-ends. Returns
    // true once a placed chain meets the size/word targets.
    function extend() {
      if (allLetters.length >= targetLetters || chain.length >= maxWords) {
        return tiles.size >= minTiles;
      }
      const last = chain[chain.length - 1].slice(-1);
      const candidates = (genByFirst[last] || []).filter((w) => !used.has(w));
      if (!candidates.length) return tiles.size >= minTiles;

      // Simulate the greedy placer's path from the junction assuming no tile
      // reuse (each step lands on a fresh empty cell), running placeLetter's same
      // deterministic rule to predict where it would be at each position li. The
      // letters on board tiles adjacent to predictedPath[li-1] are then exactly
      // the set the placer CAN reuse at step li. (A hex-distance approximation
      // here credits unreachable tiles, making larger localRadius reduce overlap.)
      const junction = seq[seq.length - 1].cellIdx;
      const predictedPath = [junction];
      const predOccupied = new Set(tiles.keys());
      for (let li = 1; li <= localRadius; li++) {
        const prev = predictedPath[li - 1];
        let best = -1, bestFilled = -1, bestDist = Infinity;
        for (const n of neighbors(prev)) {
          if (predOccupied.has(n)) continue;
          const filled = neighbors(n).filter(x => predOccupied.has(x)).length;
          const dist = hexDistance(n, start);
          if (filled > bestFilled || (filled === bestFilled && dist < bestDist)) {
            bestFilled = filled; bestDist = dist; best = n;
          }
        }
        if (best < 0) break;
        predictedPath.push(best);
        predOccupied.add(best);
      }
      // localReachable[li-1] = letters reusable by the placer at position li.
      const localReachable = [];
      for (let li = 1; li < predictedPath.length; li++) {
        const reachable = new Set();
        for (const n of neighbors(predictedPath[li - 1])) {
          if (tiles.has(n)) reachable.add(tiles.get(n));
        }
        localReachable.push(reachable);
      }
      const weights = candidates.map((w) => {
        let local = 0;
        for (let li = 1; li < w.length; li++) {
          const reachable = localReachable[li - 1];
          if (reachable && reachable.has(w[li])) local += Math.pow(overlapDecay, li - 1);
        }
        const lengthBonus = Math.pow(
          1 + lengthAlpha,
          -(lengthCounts[w.length] || 0),
        );
        const lw = lengthWeight[w.length] != null ? lengthWeight[w.length] : 1;
        return (local * local + overlapFloor) * lengthBonus * lw * (corrFactor[w[w.length - 1]] || 1);
      });
      const ordered = weightedShuffle(candidates, weights, rng);

      for (const w of ordered) {
        if (budget <= 0) return false;
        budget--;
        const seqLen = seq.length;
        const res = placeWord(w, false);
        if (res.ok) {
          chain.push(w);
          used.add(w);
          allLetters += w;
          lengthCounts[w.length] = (lengthCounts[w.length] || 0) + 1;
          if (extend()) return true;
          lengthCounts[w.length]--;
          allLetters = allLetters.slice(0, -w.length);
          used.delete(w);
          chain.pop();
        }
        for (const c of res.added) tiles.delete(c);
        seq.length = seqLen;
      }
      return false;
    }

    // Try seed words in a random order until one yields a complete board. A
    // whole-board restart is rare — most dead-ends recover by trying the next
    // word, not the next seed.
    for (const seedWord of shuffle(genPool)) {
      if (budget <= 0) break;
      tiles = new Map();
      seq = [];
      chain = [];
      used = new Set();
      lengthCounts = {};
      allLetters = "";

      const res = placeWord(seedWord, true);
      if (!res.ok) continue;
      chain.push(seedWord);
      used.add(seedWord);
      allLetters = seedWord;
      lengthCounts[seedWord.length] = 1;

      if (extend()) {
        return {
          chain: chain.slice(),
          tiles: new Map(tiles),
          seq: seq.slice(),
          start,
          targetWords: chain.length,
          totalTiles: tiles.size,
        };
      }
    }

    // Exhausted the pool (or budget) without a board — reseed.
    return generateBoard((seed + 1) >>> 0, genPool, options);
  }

  const api = {
    mulberry32,
    seedForDate,
    dateKey,
    GRID,
    idx,
    toRC,
    neighbors,
    isAdjacent,
    hexDistance,
    generateBoard,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.BlossomGen = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
