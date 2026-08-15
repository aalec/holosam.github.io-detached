# Blossom difficulty

Predicts how hard a board is to solve.

## Definition

The scored unit is a (board, solution) pair. A board's difficulty is the score
of its lowest-scoring solution.

- The easiest solution is not always the shortest. The generator's chain is
  scored as a candidate even when longer than the minimum.
- The minimum is taken over all solutions. Truncating the solution list biases
  the floor upward on boards with many solutions, which are the boards whose
  floor should be lowest. `solve` reports `complete`; a floor from an incomplete
  search is an upper bound.

## Two vectors

`WITHIN` ranks solutions on one board. `ACROSS` ranks boards against each other.

| term | definition | WITHIN | ACROSS |
|---|---|---|---|
| `obs_max` | obscurity of the least-known word | 1.0 | 0 |
| `obs_early` | obscurity weighted `1/(i+1)` by chain position | 1.0 | 0 |
| `obs_mean` | mean obscurity | 0.5 | 0 |
| `old_frac` | fraction of each word on tiles covered by earlier words | 0.3 | 1.5 |
| `hint` | fraction of remaining tiles the word covers, negated | 0.3 | 1.5 |
| `ungen` | fraction of steps `gen.js` placement would not produce | 1.0 | 1.0 |
| `out_of_range` | fraction of words outside the generator's 4-8 letters | 0.4 | 0.5 |
| `revisits` | cells revisited within a word, per word | 0.3 | 0.3 |
| `rare_min` | peak letter surprisal of the least distinctive word, negated | 0 | 0.2 |
| `turns` | direction changes per word | 0.1 | 0.1 |
| `n_words` | words in the solution | 0.1 | 0.1 |
| `len_mean` | mean word length, negated | 0 | 0 |
| `short_frac` | fraction of words of 4 letters or fewer | 0 | 0 |

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
floors while geometry terms do not. Obscurity is zero in `ACROSS` because what
survives that compression carries no signal: over 5 board comparisons built to
isolate it, the rater agreed with its direction 1 time.

## Saturation

Raw score maps to perceived difficulty by `k * log1p((s + 0.80) / k)`, `k = 1.2`.

Two ranked sets came back as flat ties at the hard end while the linear score
spread them: one board where a single very hard word swamped every other
difference, one where high `ungen` did.

The transform is monotone, so it cannot reorder anything. On the ranked sets it
leaves ordered pairs at 36/52 at every `k` and takes ties from 4/18 to 14/18.

## obscurity

`2.58 - prevalence`, where prevalence is the probit-scale proportion of people
who report knowing the word and 2.58 is the scale ceiling.

Lookup order:

1. the word
2. its lemma (suffix stripping: `-s -es -ies -ed -ing -er -ers -est`)
3. imputed from log frequency, by a regression of prevalence on log frequency
   fitted over words carrying both

Direct coverage of `words.js` is 53%. Lemmatising raises it to 92%. Imputation
handles the rest: proper nouns are absent from the norms regardless of how
common they are (`ROMEO`, frequency 7286) and are separated by step 3 from words
absent because they are unknown (`SYSOP`, frequency 0).

A lemma's prevalence does not transfer to a surface form the corpus does not
attest. `CHOICEST` resolved to `CHOICE` and scored obscurity 0.00 — the ceiling
— on a form of frequency 0 against the lemma's 77,197; `TAXER`/`TAX` is the same
shape. Forms of frequency 0 are discounted by `0.25 * log10(lemma frequency)`.

Plurals are exempt. They are fully productive, so an unattested one says nothing
about familiarity: `ESPRESSOS` is not obscure. Discounting by the lemma:form
frequency ratio instead of by absence also taxes `ANSWERED` (0.085) and `TREES`
(0.50), and cost 3 of 28 within-board judgments at every setting large enough to
correct `CHOICEST`. Restricted to unattested non-plurals, the correction costs
nothing.

## ungen

`gen.js` `placeLetter` selects the empty neighbour with the most filled
neighbours, ties broken by distance to the start tile. Verified exact over
34,267 placements, 0 exceptions.

`ungen` replays a solution under that rule, counting steps where the cell
reached was not the rule's choice.

## out_of_range

`word_bank.txt` is 4-8 letters, so a generated chain never contains a 3-letter
word and players do not learn to look for one. Four solutions where the model's
floor was wrong turned on exactly this: `SIR`, `POT`, `SPA`, `ELF`.

## hint

A word is constrained by the tiles still uncovered. `FIREBALL` at position 6
with `F-E-B-A-L-L` remaining is not the same problem as `FIREBALL` at position 2.

## Fitting

`WITHIN` is fitted by coordinate search on 30 human pairwise judgments of which
of two solutions is harder to find, on solutions sharing a board: 27/30.

`ACROSS` is **not** fitted. It is set from per-term agreement over 25 pairwise
board comparisons and 6 ranked sets of 5. Fitting was tried and rejected:

| model | in-sample | leave-one-out |
|---|---|---|
| unfitted hand-set | 13/25 | — |
| fitted, 13 features | 20/25 | 13/25 |
| fitted, 7 features | 19/25 | 13/25 |
| fitted, 4 geometry | 16/25 | 13/25 |

No fitted variant generalised better than not fitting. 13 weights on 25
judgments is underdetermined, and the per-term agreement table is a
lower-variance estimator: it collapses 5 judgments into one sign per term
instead of placing 13 continuous weights. The set vector scores 17/25.

### Comparison design

Each comparison moves one feature group by 1.8-3.6 SD and holds every other
feature inside 0.35-0.99 SD, so a term is identified by the comparisons that
moved its group. Presentation order is randomised.

Rankings of 5 replaced pairs partway through: one ranking yields 10 pairwise
constraints, so 6 rankings gave 60 against 25 from 25 pairwise rounds.

Current: 14/20 ordered and 3/5 ties on the pairwise rounds, 36/52 ordered and
14/18 ties on the ranked sets.

## Distribution

500 boards, current tuning.

| board difficulty | |
|---|---|
| mean | 0.495 |
| variance | 0.0163 (sd 0.128) |
| min / max | 0.026 / 0.828 |
| p10 / median / p90 | 0.331 / 0.505 / 0.651 |
| IQR | 0.173 (0.416-0.589) |

| solution spread within a board | |
|---|---|
| boards with >1 solution | 396 of 500 (79%) |
| median range | 0.677 |
| mean range | 0.639 |
| p10 / p90 | 0.077 / 1.078 |
| max range | 1.287 |

The median within-board spread is 5.3x the SD of board difficulty across the
pool. Which solution a player finds moves difficulty considerably more than
which board they were given.

## Tested and dropped

| factor | result |
|---|---|
| reading direction (steps against left-to-right, top-to-bottom) | tie at 4.97 SD separation, all controls within 0.52 SD |
| character n-gram entropy | 6 variants (bigram/trigram x type/token x total/per-char), at or below chance |
| word self-overlap (`SALSA`) | no intrinsic effect; realised overlap is `revisits` |
| orthographic neighbourhood (edit distance 1) | easy mean 10.0, medium mean 9.8 |
| concreteness | all three hardest-rated words score high |
| `word_bank.txt` membership | superseded by prevalence: 19/24 vs 22/24 |
| word length (`len_mean`, `short_frac`) | 2 ranked comparisons, both returned ties |
| obscurity across boards | 1/5 agreement on comparisons built to isolate it |

## Limitations

- `ACROSS` is set, not fitted, and rests on 31 comparisons.
- 5 comparisons per term determines a sign, not a magnitude. Only the reuse
  weight is constrained by the data, by a plateau from 1.0 to 4.0.
- Chain length cannot be isolated in this pool. At a band where 5 distinct word
  counts coexist (2.0 SD) nothing else is held constant, and the distribution is
  4,093 boards at 6 words against 54 at 4 and one each at 3 and 8.
- The saturation constant is fitted to tie data from 2 ranked sets.
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

The memo stores, per failed state, which used-words the failure depended on, and
is reused only when those are used again. Successes are not memoized: every
solution is needed.

One trie serves every board. Walks only follow letters that are on the board, so
filtering the word list per board changes nothing but the trie's size.

Measured over 6,000 boards: 0.072 s/board, 169,596 solutions, no board hitting
the time budget.
