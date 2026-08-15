#!/usr/bin/env python3
"""Blossom solver. Finds every shortest solution to a board.

Boards come from blossom-solve.js --json.

1. Per start cell, enumerate (word, end_cell, covered_bitmask) walks by DFS
   through the hex graph and a trie of valid words.
2. Iterative deepening on word count.
3. Prune: each further word covers at most 11 new cells (12-letter cap, first
   letter shared with the previous word's end).
"""
import json
import os
import re
import sys
import time

GRID = 12
MAX_WORD_LEN = 12          # matches game.js
MIN_WORD_LEN = 3
WORDS_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "..", "assets", "blossom", "words.js")


def idx(r, c):
    return r * GRID + c


def to_rc(i):
    return divmod(i, GRID)


def neighbors(i):
    r, c = to_rc(i)
    cand = [(r, c - 1), (r, c + 1), (r - 1, c), (r - 1, c + 1),
            (r + 1, c - 1), (r + 1, c)]
    return [idx(rr, cc) for rr, cc in cand
            if 0 <= rr < GRID and 0 <= cc < GRID]


def load_words(path=WORDS_JS):
    """BLOSSOM_WORDS, the list answers validate against."""
    content = open(path).read()
    m = re.search(r'window\.BLOSSOM_WORDS\s*=\s*(\[.*?\]);', content, re.DOTALL)
    if m:
        return json.loads(m.group(1))
    m = re.search(r'window\.BLOSSOM_WORDS\s*=\s*"((?:[^"\\]|\\.)*)"', content)
    return m.group(1).split("\\n")


def render(tiles, start):
    """ASCII hex grid. Start tile uppercase."""
    rs = [to_rc(i)[0] for i in tiles]
    cs = [to_rc(i)[1] for i in tiles]
    out = []
    for r in range(min(rs), max(rs) + 1):
        row = " " * (r - min(rs))
        for c in range(min(cs), max(cs) + 1):
            cell = idx(r, c)
            if cell not in tiles:
                row += "  "
            else:
                ch = tiles[cell]
                row += (ch.upper() if cell == start else ch) + " "
        out.append(row.rstrip())
    return "\n".join(out)


def walks_for_word(tiles, word, start_cell, cap=20000):
    """Every cell path spelling `word` from start_cell.

    Paths may revisit a cell; game.js requires only pairwise adjacency.
    """
    if tiles.get(start_cell) != word[0]:
        return []
    paths = [[start_cell]]
    for ch in word[1:]:
        nxt = []
        for p in paths:
            for n in neighbors(p[-1]):
                if tiles.get(n) == ch:
                    nxt.append(p + [n])
        paths = nxt[:cap]
        if not paths:
            return []
    return paths


def realizations(tiles, start, words, limit=1):
    """Full cell-walks of a word sequence that cover the whole board."""
    target = set(tiles)
    out = []
    stack = [(start, [], {start})]
    while stack and len(out) < limit:
        cell, sofar, cov = stack.pop()
        if len(sofar) == len(words):
            if cov >= target:
                out.append(sofar)
            continue
        for p in walks_for_word(tiles, words[len(sofar)], cell):
            stack.append((p[-1], sofar + [p], cov | set(p)))
    return out


def walks_from_seq(seq, chain):
    """gen.js placement as one cell-walk per word."""
    by_word = {}
    for e in seq:
        by_word.setdefault(e["wordIdx"], []).append((e["letterIdx"], e["cellIdx"]))
    walks = []
    for wi in range(len(chain)):
        cells = [c for _, c in sorted(by_word[wi])]
        if wi > 0:
            cells = [walks[-1][-1]] + cells      # shared tile with previous word
        walks.append(cells)
    return walks


class TimedOut(Exception):
    pass


def solve(tiles, start, max_seconds=90, verbose=False):
    """Returns (solutions, complete).

    solutions: distinct minimum-length solutions as word lists.
    complete:  False if the time budget expired, making solutions a subset.
    """
    cells = sorted(tiles)
    bits = {c: 1 << i for i, c in enumerate(cells)}
    N = len(cells)
    FULL = (1 << N) - 1
    nbrs = {c: [n for n in neighbors(c) if n in tiles] for c in cells}
    on_board = set(tiles.values())

    words = [w for w in load_words()
             if MIN_WORD_LEN <= len(w) <= MAX_WORD_LEN and set(w) <= on_board]
    trie = {}
    for w in words:
        node = trie
        for ch in w:
            node = node.setdefault(ch, {})
        node[0] = w

    def moves_from(cell):
        letter = tiles[cell]
        if letter not in trie:
            return []
        seen, out = set(), []

        def dfs(c, node, covered):
            w = node.get(0)
            if w is not None:
                key = (w, c, covered)
                if key not in seen:
                    seen.add(key)
                    out.append((covered, c, w))
            for n in nbrs[c]:
                child = node.get(tiles[n])
                if child is not None:
                    dfs(n, child, covered | bits[n])

        dfs(cell, trie[letter], bits[cell])
        return out

    all_moves = {c: moves_from(c) for c in cells}
    max_cov = {c: max((bin(m[0]).count("1") for m in all_moves[c]), default=0)
               for c in cells}

    min_depth = -((-(N - 1)) // 11)
    for depth_cap in range(max(1, min_depth), 15):
        t0 = time.time()
        found, path, used = [], [], set()
        deadline = t0 + max_seconds
        timed_out = [False]

        def dfs(cell, covered, depth):
            if time.time() > deadline:
                raise TimedOut()
            if covered == FULL:
                found.append(path[:])
                return
            if depth == 0:
                return
            remaining = bin(FULL & ~covered).count("1")
            if remaining > max_cov[cell] + (depth - 1) * 11:
                return
            min_new = 0 if depth == 1 else max(0, remaining - (depth - 1) * 11)
            ranked = []
            for cov, end, w in all_moves[cell]:
                if w in used:
                    continue
                n_new = bin(cov & ~covered).count("1")
                if n_new < min_new:
                    continue
                ranked.append((-n_new, cov, end, w))
            ranked.sort()
            for _, cov, end, w in ranked:
                path.append(w)
                used.add(w)
                dfs(end, covered | cov, depth - 1)
                path.pop()
                used.remove(w)

        try:
            dfs(start, bits[start], depth_cap)
        except TimedOut:
            timed_out[0] = True

        if found:
            uniq, seen_seq = [], set()
            for s in found:
                t = tuple(s)
                if t not in seen_seq:
                    seen_seq.add(t)
                    uniq.append(s)
            if verbose:
                print(f"depth {depth_cap}: {len(uniq)} solution(s) "
                      f"in {time.time()-t0:.1f}s"
                      + ("  [INCOMPLETE — hit time limit]" if timed_out[0] else ""))
            return uniq, not timed_out[0]
        if timed_out[0]:
            return [], False
    return [], True


def check(tiles, start, words, valid):
    """Legal and covers every tile."""
    if len(set(words)) != len(words):
        return False, "repeats a word"
    for w in words:
        if w not in valid:
            return False, f"{w} not in BLOSSOM_WORDS"
    return (bool(realizations(tiles, start, list(words), limit=1)),
            "not walkable or does not cover every tile")


if __name__ == "__main__":
    boards = json.load(sys.stdin if len(sys.argv) < 2 else open(sys.argv[1]))
    for b in boards:
        tiles = {int(k): v for k, v in b["tiles"].items()}
        print(render(tiles, b["start"]))
        sols, complete = solve(tiles, b["start"], verbose=True)
        print(f"generator: {' -> '.join(w.upper() for w in b['chain'])}")
        for s in sols[:20]:
            print("  " + " -> ".join(w.upper() for w in s))
        if not complete:
            print("  (search incomplete)")
