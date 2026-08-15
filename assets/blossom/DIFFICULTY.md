# Blossom difficulty

Predicts how hard a board is to solve.

## Definition

The scored unit is a (board, solution) pair. A board's difficulty is the score
of its lowest-scoring solution.

- The easiest solution is not always the shortest. The generator's chain is
  scored as a candidate even when longer than the minimum.
- The minimum is taken over all solutions. Truncating the solution list biases
  the floor upward on boards with many solutions, which are the boards whose
  floor should be lowest. `solve` reports `complete`; a floor taken from an
  incomplete search is an upper bound and is flagged as such.

## Solver

`scripts/blossom_solver.py`. Iterative deepening on word count over
(covered_bitmask, end_cell, word_id) moves, capped at the generator chain's
length — the chain always solves the board, so no answer is above it.

| bound | definition |
|---|---|
| `MAXNEW` | most new cells any single move on this board covers; 6-10 in practice, against the 11 implied by the 12-letter cap |
| `reach[k][cell]` | cells reachable from `cell` within k words; prune when an uncovered cell falls outside |
| min coverage | per-move floor on new cells, exact at the last word |
| fail memo | failed `(cell, covered, depth)` states, since word order permutes into the same state |

The memo stores, per failed state, which used-words the failure depended on,
and is reused only when those are used again. Successes are not memoized: every
solution is needed.

One trie serves every board. Walks only follow letters that are on the board,
so filtering the word list per board changes nothing but the trie's size.

Measured over 6,000 boards: 0.072 s/board, 169,596 solutions, no board hitting
the time budget.

## Terms

All terms are oriented so larger is harder. Score is their weighted sum.

| term | definition | weight |
|---|---|---|
| `obs_max` | obscurity of the least-known word | 1.0 |
| `obs_early` | obscurity weighted `1/(i+1)` by chain position | 1.0 |
| `obs_mean` | mean obscurity | 0.5 |
| `ungen` | fraction of steps `gen.js` placement would not produce | 1.0 |
| `revisits` | cells revisited within a word, per word | 0.3 |
| `old_frac` | fraction of each word on tiles covered by earlier words | 0.3 |
| `hint` | fraction of remaining tiles the word covers, negated | 0.3 |
| `turns` | direction changes per word | 0.1 |
| `n_words` | words in the solution | 0.1 |

### obscurity

`2.58 - prevalence`, where prevalence is the probit-scale proportion of people
who report knowing the word and 2.58 is the scale ceiling.

Prevalence lookup order:

1. the word
2. its lemma (suffix stripping: `-s -es -ies -ed -ing -er -ers -est`)
3. imputed from log frequency, by a regression of prevalence on log frequency
   fitted over words carrying both

Direct coverage of `words.js` is 53%. Lemmatising raises it to 92%. Imputation
handles the rest: proper nouns are absent from the norms regardless of how
common they are (`ROMEO`, frequency 7286) and are separated by step 3 from
words absent because they are unknown (`SYSOP`, frequency 0).

`obs_max` is separate from `obs_mean` because one unknown word costs more than
several uncommon ones.

### ungen

`gen.js` `placeLetter` selects the empty neighbour with the most filled
neighbours, ties broken by distance to the start tile. Verified exact over
34,267 placements, 0 exceptions.

`ungen` replays a solution under that rule, counting steps where the cell
reached was not the rule's choice.

### hint

A word is constrained by the tiles still uncovered. `FIREBALL` at position 6
with `F-E-B-A-L-L` remaining is not the same problem as `FIREBALL` at
position 2.

## Intra-board vs inter-board

Feature spread over 139 multi-solution boards:

| term | within-board SD | across-floor SD | ratio |
|---|---|---|---|
| `obs_max` | 0.658 | 0.317 | 0.48 |
| `obs_early` | 0.180 | 0.099 | 0.55 |
| `obs_mean` | 0.173 | 0.097 | 0.56 |
| `ungen` | 0.050 | 0.081 | 1.63 |
| `revisits` | 0.136 | 0.219 | 1.60 |
| `turns` | 0.244 | 0.496 | 2.03 |
| `old_frac` | 0.023 | 0.058 | 2.55 |
| `hint` | 0.017 | 0.053 | 3.15 |
| `n_words` | 0.000 | 0.603 | inf |

Taking a minimum selects for low obscurity, so word terms compress across board
floors while geometry terms do not. Word terms separate solutions within a
board; geometry terms separate boards from each other. `n_words` is constant
within a board.

Weights are fitted on within-board comparisons only. Cross-board ranking is
directional, not calibrated: obscurity's contribution across floors (1.0 x
0.317) still exceeds every geometry term (0.02-0.08). Rescaling features does
not correct this.

## Fitting

Human pairwise judgments of which of two solutions is harder to find, on
solutions sharing a board. Fitted by coordinate search maximising agreement,
ties scored separately.

Current: 26/28 ordered pairs, 6/6 ties. 9 weights on 28 comparisons; hand-set
weights score the same.

## Tested and dropped

| factor | result |
|---|---|
| reading direction (steps against left-to-right, top-to-bottom) | tie at 4.97 SD separation, all controls within 0.52 SD |
| character n-gram entropy | 6 variants (bigram/trigram x type/token x total/per-char), at or below chance |
| word self-overlap (`SALSA`) | no intrinsic effect; realised overlap is `revisits` |
| orthographic neighbourhood (edit distance 1) | easy mean 10.0, medium mean 9.8 |
| concreteness | all three hardest-rated words score high |
| `word_bank.txt` membership | superseded by prevalence: 19/24 vs 22/24 |

## Limitations

- Cross-board weights are not fitted.
- Seed 2983 judgments are not in the fit set; current weights rank two of its
  solutions against them.
- Whether a solution reachable only through validation-only vocabulary
  (`SYSOP`, `RENNET`, `SETTS`) should set a board's floor is undecided.
- Morphological transparency (`REHEAR` = `RE` + `HEAR`) is implemented and
  disabled: no effect on recorded judgments.
- Judgments are made from reading a solution, not from finding it.

## Running

```bash
node scripts/blossom-solve.js --json | python3 scripts/blossom-difficulty.py
node scripts/blossom-solve.js --json --seeds 0-99 > boards.json
python3 scripts/blossom-difficulty.py boards.json --quiet
```

Requires two data files not in this repo:

| file | format | source |
|---|---|---|
| `prevalence.tsv` | `word<TAB>probit` | Brysbaert et al. word-prevalence norms, US probit scale |
| `frequency.txt` | `word<SPACE>count` | any large frequency list; OpenSubtitles via hermitdave/FrequencyWords |

Location: `scripts/data/`, or `--data DIR`, or `BLOSSOM_DATA`.

The prevalence norms carry no stated licence; the frequency list is CC BY-SA
4.0. Neither is redistributed here, as with the SCOWL dictionary behind
`words.js`.
