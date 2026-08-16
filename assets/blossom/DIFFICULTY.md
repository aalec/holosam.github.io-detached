# Blossom difficulty

A metric for how hard a board is to solve. Computed by
`scripts/blossom-difficulty.py`.

## Definition

The scored unit is a (board, solution) pair. A board's difficulty is the
`ACROSS` score of its easiest solution, where easiest is decided by `WITHIN` —
choosing which solution a player finds is a within-board ranking, and scoring it
against other boards is not.

Candidates are every solution up to the generator chain's length, not only the
shortest. The easiest solution is often not the shortest, and restricting to
minimum length makes the hardest boards artifacts of that restriction. The chain
is never exceeded: it always solves the board.

Score is a weighted sum of the terms below, passed through
`k * log1p((s + 0.80) / k)` with `k = 1.2`. That transform is monotone, so it
reorders nothing; it compresses the top of the scale, where boards stop being
distinguishable from one another.

## Terms

All oriented so larger is harder. `WITHIN` ranks solutions on one board;
`ACROSS` ranks boards against each other.

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

Two vectors because taking a minimum over solutions selects for low obscurity,
so word terms compress across board floors while geometry terms do not:

| term | within-board SD | across-floor SD | ratio |
|---|---|---|---|
| `obs_max` | 0.658 | 0.317 | 0.48 |
| `obs_mean` | 0.173 | 0.097 | 0.56 |
| `ungen` | 0.050 | 0.081 | 1.63 |
| `old_frac` | 0.023 | 0.058 | 2.55 |
| `hint` | 0.017 | 0.053 | 3.15 |
| `n_words` | 0.000 | 0.603 | inf |

`WITHIN` is fitted on 30 pairwise human judgments of which of two solutions on
one board is harder to find: 27/30. `ACROSS` is set from per-term agreement over
31 board comparisons, not fitted — fitting scored 20/25 in sample and 13/25
leave-one-out, no better than not fitting, against 17/25 for the set vector.

### obscurity

`2.58 - prevalence`, the probit-scale proportion of people who report knowing
the word, against the 2.58 scale ceiling. Looked up on the word, then its lemma,
then imputed from log frequency. Direct coverage of `words.js` is 53%,
lemmatising raises it to 92%, imputation covers the rest — including proper
nouns, which the norms omit at any frequency (`ROMEO`).

A lemma's prevalence does not transfer to a surface form the corpus does not
attest: `CHOICEST` resolved to `CHOICE` and scored 0.00, the ceiling, on a form
of frequency 0 against the lemma's 77,197. Unattested forms are discounted by
`0.25 * log10(lemma frequency)`. Plurals are exempt, being fully productive.

### ungen

`gen.js` `placeLetter` takes the empty neighbour with the most filled
neighbours, ties broken by `hexDistance` to the start tile. `ungen` replays a
solution under that rule and counts steps the rule would not have taken.

`hexDistance` must be copied from `gen.js` exactly. It is not an offset-to-cube
conversion, and substituting one disagrees on 63% of cell pairs. Correct, the
generator's own chain scores 0 deviations over 6,905 placements.

### out_of_range

`word_bank.txt` is 4-8 letters, so a generated chain never contains a 3-letter
word and players do not learn to look for one.

## Distribution

500 boards.

| board difficulty | | solution spread within a board | |
|---|---|---|---|
| mean | 0.499 | boards with >1 solution | 421 of 500 (84%) |
| variance | 0.0205 (sd 0.143) | median range | 0.856 |
| min / max | 0.026 / 0.877 | mean range | 0.753 |
| p10 / median / p90 | 0.318 / 0.507 / 0.678 | p10 / p90 | 0.101 / 1.199 |
| IQR | 0.196 (0.402-0.598) | max range | 1.507 |

The median within-board spread is 6.0x the SD of board difficulty across the
pool: which solution a player finds moves difficulty considerably more than
which board they were given.

Board difficulty is tightly clustered, the middle half spanning 0.196 of an
observed 0.85 range. 86% of boards have an easiest solution that `gen.js`
placement would have produced exactly (`ungen` 0).

## Limitations

- `ACROSS` is set, not fitted, and rests on 31 comparisons. Five per term
  determines a sign, not a magnitude.
- Chain length cannot be isolated in this pool: at a band where 5 distinct word
  counts coexist nothing else is held constant, and the distribution is 4,093
  boards at 6 words against 54 at 4.
- Judgments are made from reading a solution, not from finding it.
- Tested and dropped: reading direction, character n-gram entropy, word
  self-overlap, orthographic neighbourhood, concreteness, `word_bank.txt`
  membership, word length, and obscurity across boards.

## Running

```bash
node scripts/blossom-solve.js --json | python3 scripts/blossom-difficulty.py
node scripts/blossom-solve.js --json --seeds 0-99 > boards.json
python3 scripts/blossom-difficulty.py boards.json --quiet
```

Requires two data files not in this repo, in `scripts/data/`, or `--data DIR`,
or `BLOSSOM_DATA`:

| file | format | source |
|---|---|---|
| `prevalence.tsv` | `word<TAB>probit` | Brysbaert et al. word-prevalence norms, US probit scale |
| `frequency.txt` | `word<SPACE>count` | any large frequency list; OpenSubtitles via hermitdave/FrequencyWords |

The prevalence norms carry no stated licence; the frequency list is CC BY-SA
4.0. Neither is redistributed here, as with the SCOWL dictionary behind
`words.js`.
