#!/usr/bin/env python3
"""Blossom solver. Every solution to a board, up to a word-count cap.

Boards come from blossom-solve.js --json.

One trie over the whole word list, shared by every board; walks only follow
letters that are on the board, so filtering per board would only shrink the
trie. Per start cell, enumerate (covered_bitmask, end_cell, word_id) walks, then
iterative deepening on word count.

Bounds: MAXNEW, the most new cells any one move covers on this board (6-10 in
practice, against the 11 the 12-letter cap implies); reach[k][cell], cells
reachable within k words; an exact coverage requirement at the last word; and a
memo of failed (cell, covered, depth) states, since word order permutes into the
same state. The memo records which used-words each failure depended on and is
reused only when those are used again. Successes are never memoized — every
solution is needed.

0.072 s/board over 6,000 boards.
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


class Lexicon:
    """Word list, trie and id table. One instance serves every board."""

    def __init__(self, words):
        self.words = [w for w in words if MIN_WORD_LEN <= len(w) <= MAX_WORD_LEN]
        self.trie = {}
        for wid, w in enumerate(self.words):
            node = self.trie
            for ch in w:
                node = node.setdefault(ch, {})
            node[0] = wid


_LEX = None


def lexicon(path=WORDS_JS):
    global _LEX
    if _LEX is None:
        _LEX = Lexicon(load_words(path))
    return _LEX


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


class TimedOut(Exception):
    pass


def _moves_from(tiles, nbrs, bits, trie, cell):
    """(covered_bitmask, end_cell, word_id) for every walk starting at cell."""
    node0 = trie.get(tiles[cell])
    if node0 is None:
        return []
    seen, out = set(), []
    stack = [(cell, node0, bits[cell])]
    while stack:
        c, node, covered = stack.pop()
        wid = node.get(0)
        if wid is not None:
            key = (wid, c, covered)
            if key not in seen:
                seen.add(key)
                out.append((covered, c, wid))
        for n in nbrs[c]:
            child = node.get(tiles[n])
            if child is not None:
                stack.append((n, child, covered | bits[n]))
    return out


def solve(tiles, start, max_words=None, max_seconds=90, verbose=False, lex=None,
          all_depths=False):
    """Returns (solutions, complete).

    solutions: distinct minimum-length solutions as word lists, or with
               all_depths, every solution of length <= max_words.
    complete:  False if the time budget expired, making solutions a subset.
    max_words: cap on iterative deepening. Pass len(board["chain"]).

    all_depths runs one pass at max_words instead of deepening. The DFS records
    on covered == FULL whatever depth remains, so that single pass finds every
    solution at or below the cap. Scoring needs them: a board's easiest solution
    is often longer than its shortest, and restricting to minimum length made
    the hardest boards artifacts of that restriction.
    """
    lex = lex or lexicon()
    words, trie = lex.words, lex.trie
    cells = sorted(tiles)
    bits = {c: 1 << i for i, c in enumerate(cells)}
    N = len(cells)
    FULL = (1 << N) - 1
    nbrs = {c: [n for n in neighbors(c) if n in tiles] for c in cells}

    all_moves = {c: _moves_from(tiles, nbrs, bits, trie, c) for c in cells}
    max_cov = {c: max((cov.bit_count() for cov, _, _ in all_moves[c]), default=0)
               for c in cells}
    MAXNEW = max(max_cov.values()) - 1      # the move's own start cell is covered
    if MAXNEW <= 0:
        return [], True

    cap = max_words or 14
    min_depth = max(1, -((-(N - 1)) // MAXNEW))
    if min_depth > cap:
        return [], True

    # reach[k][c]: cells reachable from c within k words.
    one, ends = {}, {}
    for c in cells:
        m = 0
        for cov, _, _ in all_moves[c]:
            m |= cov
        one[c] = m
        ends[c] = {e for _, e, _ in all_moves[c]}
    reach = [dict.fromkeys(cells, 0), one]
    for k in range(2, cap + 1):
        prev = reach[k - 1]
        cur = {}
        for c in cells:
            m = one[c]
            for e in ends[c]:
                m |= prev[e]
            cur[c] = m
        reach.append(cur)

    EMPTY = frozenset()
    depths = [cap] if all_depths else range(min_depth, cap + 1)
    for depth_cap in depths:
        t0 = time.time()
        deadline = t0 + max_seconds
        found, path, used = [], [], set()
        nodes = [0]
        fail = {}

        def dfs(cell, covered, depth):
            """Returns the used-words this subtree's outcome depended on."""
            nodes[0] += 1
            if not nodes[0] & 0x3FF and time.time() > deadline:
                raise TimedOut()
            if covered == FULL:
                found.append(path[:])
                return EMPTY
            if depth == 0:
                return EMPTY
            left = FULL & ~covered
            if left & ~reach[depth][cell]:
                return EMPTY
            remaining = left.bit_count()
            if remaining > max_cov[cell] + (depth - 1) * MAXNEW:
                return EMPTY

            if depth == 1:
                # exact: the last word must finish the board
                conflict = None
                for cov, _, wid in all_moves[cell]:
                    if cov & left != left:
                        continue
                    if wid in used:
                        conflict = {wid} if conflict is None else conflict | {wid}
                        continue
                    path.append(wid)
                    found.append(path[:])
                    path.pop()
                return EMPTY if conflict is None else frozenset(conflict)

            key = (cell, covered, depth)
            prev = fail.get(key)
            if prev is not None and prev <= used:
                return prev

            min_new = remaining - (depth - 1) * MAXNEW
            ranked, conflict = [], set()
            for cov, end, wid in all_moves[cell]:
                n_new = (cov & left).bit_count()
                if n_new < min_new:
                    continue
                if wid in used:
                    conflict.add(wid)
                    continue
                ranked.append((-n_new, cov, end, wid))
            ranked.sort()
            before = len(found)
            for _, cov, end, wid in ranked:
                path.append(wid)
                used.add(wid)
                sub = dfs(end, covered | cov, depth - 1)
                path.pop()
                used.remove(wid)
                if sub:
                    # a dependence on wid itself recurs whatever the caller used
                    conflict |= sub - {wid}
            conflict = frozenset(conflict)
            if len(found) == before and len(fail) < 2_000_000:
                fail[key] = conflict
            return conflict

        timed_out = False
        try:
            dfs(start, bits[start], depth_cap)
        except TimedOut:
            timed_out = True

        if found:
            uniq, seen_seq = [], set()
            for s in found:
                t = tuple(s)
                if t not in seen_seq:
                    seen_seq.add(t)
                    uniq.append([words[i] for i in s])
            if verbose:
                print(f"depth {depth_cap}: {len(uniq)} solution(s) "
                      f"in {time.time()-t0:.1f}s"
                      + ("  [INCOMPLETE — hit time limit]" if timed_out else ""))
            return uniq, not timed_out
        if timed_out:
            return [], False
    return [], True
