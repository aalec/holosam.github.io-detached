# Blossom

Blossom is a daily word game about linking words to fill a board.

It's served purely as a static site with local browser storage.

## Relevant source

- `assets/blossom/` - (this directory) core source code and word banks
- `content/games/` - url for accessing the game on the site
- `content/posts/blossom.md` - my post describing the history of the game
- `layouts/shortcodes/blossom-scripts.html` - loads this JS (see "Serving" below)
- `scripts/` - one-off tools relating to word banks and game simulation
- `static/css/` - style

## Word banks

- `word_bank.txt` - curated common words. Daily chains draw only from here, and any edit reshuffles all generated boards (including today's)
- `extra_words.txt` - words that validate but are never chain targets. Managed by `scripts/blossom-add-word.js` / `blossom-remove-word.js`
- `words.js` - GENERATED from the above plus the gitignored SCOWL dictionary. See `scripts/blossom-build-words.js` for the pipeline

## Philosophy

- This is just for fun! If people want to play every day and work on their streak, great. If someone finds it fun to edit their local browser storage to jack up their streak, that's also great.

## Learnings

From speaking to initial players
- >90% mobile only
- Casual players (most people) just play till they fill the board. targetWords is meant as a goal for more hardcore players.
  - Some of the flair (like getting a trophy for under par) is deliberately not explained, so the most dedicated players really have to earn it and get rewarded with an easter egg
- Players say things like "today's game was really fun/hard", meaning that having one canonical game per day is important (rather than easy/med/hard)
