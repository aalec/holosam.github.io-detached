#!/usr/bin/env python3
"""Score how hard a Blossom board is.

    node scripts/blossom-solve.js --json | python3 scripts/blossom-difficulty.py
    node scripts/blossom-solve.js --json --seeds 0-99 > b.json
    python3 scripts/blossom-difficulty.py b.json --top 5

Scored unit is a (board, solution) pair. A board's difficulty is the score of
its lowest-scoring solution.

Two weight vectors. WITHIN ranks solutions on one board; ACROSS ranks boards
against each other. See assets/blossom/DIFFICULTY.md.

Requires prevalence.tsv and frequency.txt, which are not in this repo. Pass
--data DIR or set BLOSSOM_DATA.
"""
import argparse
import collections
import json
import math
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from blossom_solver import (neighbors, realizations, render, solve, to_rc,
                            walks_from_seq)

DATA = os.environ.get("BLOSSOM_DATA",
                      os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))

# Ranks solutions on one board. Fitted on 30 within-board judgments.
WITHIN = {
    "obs_max": 1.0, "obs_early": 1.0, "obs_mean": 0.5,
    "out_of_range": 0.4, "len_mean": 0.0, "short_frac": 0.0, "rare_min": 0.0,
    "ungen": 1.0, "revisits": 0.3, "turns": 0.1, "old_frac": 0.3,
    "hint": 0.3, "n_words": 0.1,
}

# Ranks boards against each other. Set from per-term agreement over 25 pairwise
# and 6 ranked comparisons, not fitted: fitting failed cross-validation, scoring
# 13/25 held out against 17/25 for this vector. Obscurity is zero because it
# carries no cross-board signal — taking a minimum over solutions selects for
# low obscurity, so little variation survives.
ACROSS = {
    "old_frac": 1.5, "hint": 1.5, "ungen": 1.0, "out_of_range": 0.5,
    "revisits": 0.3, "rare_min": 0.2, "turns": 0.1, "n_words": 0.1,
    "obs_max": 0.0, "obs_early": 0.0, "obs_mean": 0.0,
    "len_mean": 0.0, "short_frac": 0.0,
}

PREV_CEILING = 2.58        # probit scale ceiling
PREV_FLOOR = -1.0          # absent from both norms and frequency
GEN_LEN_MIN, GEN_LEN_MAX = 4, 8      # word_bank.txt is 4-8 letters

# Perceived difficulty saturates: above some level boards read as uniformly
# hard. Monotone, so it reorders nothing; it only widens what counts as
# indistinguishable at the top.
SATURATION_K = 1.2
SCORE_OFFSET = 0.80        # makes every observed raw score positive

# An inflection does not inherit its lemma's familiarity. CHOICEST resolves to
# CHOICE and scored obscurity 0.00 on a surface form of frequency 0 against the
# lemma's 77,197. Penalise only forms the corpus does not attest, and exempt
# plurals: those are fully productive, so an unattested one says nothing.
UNATTESTED_PENALTY = 0.25
PRODUCTIVE = {"s", "es", "ies"}
SUFFIXES = (("s", [""]), ("es", ["", "e"]), ("ies", ["y"]),
            ("ed", ["", "e"]), ("ing", ["", "e"]),
            ("er", ["", "e"]), ("ers", ["", "e"]), ("est", ["", "e"]))

_PREV, _FREQ, _IMPUTE, _LETTER_P = {}, {}, (0.0, 0.0), None


def load_data(root):
    """prevalence.tsv: word<TAB>probit. frequency.txt: word<SPACE>count."""
    global _IMPUTE
    pp = os.path.join(root, "prevalence.tsv")
    fp = os.path.join(root, "frequency.txt")
    missing = [p for p in (pp, fp) if not os.path.exists(p)]
    if missing:
        sys.exit(f"missing data file(s): {', '.join(missing)}\n"
                 f"See assets/blossom/DIFFICULTY.md — these are licensed norms "
                 f"and are deliberately not committed. Use --data or BLOSSOM_DATA.")
    for line in open(pp):
        p = line.split("\t")
        if len(p) >= 2:
            try:
                _PREV[p[0].strip().lower()] = float(p[1])
            except ValueError:
                pass
    for line in open(fp):
        p = line.split()
        if len(p) == 2 and p[0].isalpha():
            _FREQ[p[0].lower()] = int(p[1])
    xs = [(math.log10(_FREQ[w]), v) for w, v in _PREV.items() if _FREQ.get(w, 0) > 0]
    mx = statistics.mean(x for x, _ in xs)
    my = statistics.mean(y for _, y in xs)
    slope = (sum((x - mx) * (y - my) for x, y in xs)
             / sum((x - mx) ** 2 for x, _ in xs))
    _IMPUTE = (slope, my - slope * mx)


def _bases(w):
    """(candidate lemma, suffix) pairs, best guess first."""
    y = [(w, None)]
    for suf, adds in SUFFIXES:
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            stem = w[: -len(suf)]
            y.extend((stem + a, suf) for a in adds)
            if len(stem) >= 3 and stem[-1] == stem[-2]:      # stopped -> stop
                y.append((stem[:-1], suf))
    return y


def prevalence(w):
    """Probit prevalence, imputed from frequency if absent. None if neither has it."""
    for b, suf in _bases(w):
        if b in _PREV:
            if suf is None or suf in PRODUCTIVE:
                return _PREV[b]
            fw, fb = _FREQ.get(w, 0), _FREQ.get(b, 0)
            if fw == 0 and fb > 0:
                return _PREV[b] - UNATTESTED_PENALTY * math.log10(fb)
            return _PREV[b]
    f = max(_FREQ.get(b, 0) for b, _ in _bases(w))
    if f > 0:
        # proper nouns are absent from the norms at any frequency
        return min(PREV_CEILING, _IMPUTE[0] * math.log10(f) + _IMPUTE[1])
    return None


def obscurity(w):
    p = prevalence(w)
    return max(0.0, PREV_CEILING - (PREV_FLOOR if p is None else p))


def letter_rarity(w):
    """Surprisal in bits of the word's most distinctive letter."""
    global _LETTER_P
    if _LETTER_P is None:
        c = collections.Counter()
        for word, f in _FREQ.items():
            for ch in word:
                c[ch] += f
        tot = sum(c.values())
        _LETTER_P = {ch: -math.log2(n / tot) for ch, n in c.items()}
    return max(_LETTER_P.get(ch, 12.0) for ch in w)


def _step(a, b):
    ra, ca = to_rc(a)
    rb, cb = to_rc(b)
    return (rb - ra, cb - ca)


_ANGLE = {(0, 1): 0, (-1, 1): 60, (-1, 0): 120,
          (0, -1): 180, (1, -1): 240, (1, 0): 300}


def _hex_dist(a, b):
    ra, ca = to_rc(a)
    rb, cb = to_rc(b)
    x1, z1 = ca - (ra - (ra & 1)) // 2, ra
    x2, z2 = cb - (rb - (rb & 1)) // 2, rb
    return max(abs(x1 - x2), abs(-x1 - z1 + x2 + z2), abs(z1 - z2))


def ungeneratable(walks, tiles, start):
    """Fraction of steps gen.js placement would not produce.

    placeLetter takes the empty neighbour with the most filled neighbours, ties
    broken by distance to start. Replays the solution under that rule.
    """
    filled = {start}
    bad = steps = 0
    for wk in walks:
        for a, b in zip(wk, wk[1:]):
            steps += 1
            if b in filled:
                continue
            cand = [n for n in neighbors(a) if n in tiles and n not in filled]
            if cand:
                def key(n):
                    return (-len([x for x in neighbors(n) if x in filled]),
                            _hex_dist(n, start))
                if key(b) != min(key(n) for n in cand):
                    bad += 1
            filled.add(b)
    return bad / max(1, steps)


def features(tiles, start, words, walks):
    """Oriented so higher = harder."""
    n = len(words)
    decay = [1.0 / (i + 1) for i in range(n)]
    dsum = sum(decay)
    obs = [obscurity(w) for w in words]
    lens = [len(w) for w in words]

    covered = {start}
    revisits = turns = 0
    old = hint = 0.0
    for wk in walks:
        angles = [_ANGLE[_step(a, b)] for a, b in zip(wk, wk[1:])]
        for i in range(1, len(angles)):
            d = abs(angles[i] - angles[i - 1]) % 360
            if min(d, 360 - d):
                turns += 1
        revisits += len(wk) - len(set(wk))
        cells = set(wk)
        old += len(cells & covered) / len(wk)
        left = len(tiles) - len(covered)
        hint += len(cells - covered) / max(1, left)
        covered |= cells

    return {
        "obs_max":      max(obs),
        "obs_early":    sum(o * d for o, d in zip(obs, decay)) / dsum,
        "obs_mean":     sum(obs) / n,
        "len_mean":     -sum(lens) / n,
        "short_frac":   sum(1 for x in lens if x <= 4) / n,
        "out_of_range": sum(1 for x in lens
                            if x < GEN_LEN_MIN or x > GEN_LEN_MAX) / n,
        "rare_min":     -min(letter_rarity(w) for w in words),
        "ungen":        ungeneratable(walks, tiles, start),
        "revisits":     revisits / n,
        "turns":        turns / n,
        "old_frac":     old / n,
        "hint":         -hint / n,     # more constrained by remaining = easier
        "n_words":      n,
    }


def perceived(s):
    """Raw weighted sum -> perceived difficulty."""
    return SATURATION_K * math.log1p((s + SCORE_OFFSET) / SATURATION_K)


def score_solution(tiles, start, words, walks=None, weights=WITHIN):
    if walks is None:
        r = realizations(tiles, start, list(words), limit=1)
        if not r:
            return None, None
        walks = r[0]
    f = features(tiles, start, list(words), walks)
    return sum(weights.get(k, 0) * v for k, v in f.items()), f


def score_board(board, max_seconds=90):
    """Board difficulty: the ACROSS score of its easiest solution.

    Easiest is decided by ACROSS too — a board's difficulty is how hard its best
    route is relative to other boards.
    """
    tiles = {int(k): v for k, v in board["tiles"].items()}
    start = board["start"]
    sols, complete = solve(tiles, start, max_words=len(board["chain"]),
                           max_seconds=max_seconds)
    cands = [list(s) for s in sols]
    # a longer chain can score lower, so gen.js's chain is always a candidate
    if list(board["chain"]) not in cands:
        cands.append(list(board["chain"]))
    scored = []
    for words in cands:
        r = realizations(tiles, start, list(words), limit=1)
        if not r:
            continue
        f = features(tiles, start, list(words), r[0])
        scored.append((sum(ACROSS.get(k, 0) * v for k, v in f.items()),
                       sum(WITHIN.get(k, 0) * v for k, v in f.items()),
                       words, f))
    scored.sort(key=lambda x: x[0])
    return dict(tiles=tiles, start=start, scored=scored, complete=complete,
                n_solutions=len(sols), min_depth=len(sols[0]) if sols else None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file", nargs="?", help="boards JSON (default: stdin)")
    ap.add_argument("--data", default=DATA, help="dir with prevalence.tsv + frequency.txt")
    ap.add_argument("--top", type=int, default=3, help="solutions to list per board")
    ap.add_argument("--timeout", type=int, default=90)
    ap.add_argument("--quiet", action="store_true", help="one line per board")
    args = ap.parse_args()

    load_data(args.data)
    boards = json.load(open(args.file) if args.file else sys.stdin)
    floors = []
    for b in boards:
        r = score_board(b, max_seconds=args.timeout)
        if not r["scored"]:
            print(f"seed {b['seed']}: no solution found")
            continue
        raw, _, best, _ = r["scored"][0]
        floor = perceived(raw)
        floors.append(floor)
        flag = "" if r["complete"] else "  [search incomplete — floor is an upper bound]"
        if args.quiet:
            print(f"{b['seed']}\t{floor:.2f}\t{r['n_solutions']}\t"
                  f"{' '.join(best)}{flag}")
            continue
        print("=" * 60)
        print(f"seed {b['seed']}   difficulty {floor:.2f}   "
              f"{len(r['tiles'])} tiles   {r['n_solutions']} shortest solutions{flag}")
        print()
        print(render(r["tiles"], r["start"]))
        print()
        for raw, _, words, _ in r["scored"][:args.top]:
            tag = "  <- generator" if words == list(b["chain"]) else ""
            print(f"  [{perceived(raw):5.2f}]  "
                  + " -> ".join(w.upper() for w in words) + tag)
        print()
    if len(floors) > 1:
        print(f"\n{len(floors)} boards   difficulty min {min(floors):.2f}   "
              f"median {statistics.median(floors):.2f}   max {max(floors):.2f}")


if __name__ == "__main__":
    main()
