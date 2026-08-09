#!/usr/bin/env node
// Regenerate assets/blossom/words.js from SCOWL/ESDB size-60 (US English),
// assets/blossom/word_bank.txt, and assets/blossom/extra_words.txt. Run with:
//   node scripts/blossom-build-words.js
//
// Two output lists:
//   BLOSSOM_WORDS     — validation pool: SCOWL size 60 (~110k, common English
//                       with inflections, sans the obscure tail) + all gen
//                       words + extra_words.txt (committed validate-only
//                       additions; see blossom-add-word.js).
//   BLOSSOM_GEN_WORDS — chain-generation pool: the curated word_bank.txt, capped
//                       at 8 letters to keep daily chains approachable. Longer
//                       words still validate, they just won't be targets.
//
// To revisit the validation list, change `max_size=60` in the curl below (the
// pipeline is size-agnostic):
//
//   List           ~size   Notes
//   ───────────────────────────────────────────────────────────────────────
//   SCOWL size 50  ~75k    Tighter; may reject valid less-common plurals.
//   SCOWL size 60  ~110k   Current. STRANGERS in, EAN/NEVUS/GAST out.
//   SCOWL size 70  ~160k   Looser; a few weirder archaisms creep back.
//   enable1.txt    ~173k   Scrabble-derived; lets in QI/ZA/EW-class words.
//   dwyl/english-  ~370k   Raw aggregate; what we had before, too permissive.
//
// word_bank.txt is committed; scowl-60.txt is gitignored and fetched on demand
// (rarely — only when bumping the SCOWL size) with the curl the error below prints.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCOWL_PATH = path.join(ROOT, 'assets/blossom/scowl-60.txt');
const WORD_BANK_PATH = path.join(ROOT, 'assets/blossom/word_bank.txt');
const EXTRA_PATH = path.join(ROOT, 'assets/blossom/extra_words.txt');
const OUT_PATH = path.join(ROOT, 'assets/blossom/words.js');

const MIN_LEN = 3;
const MAX_LEN = 12;
const GEN_MIN_LEN = 4;
const GEN_MAX_LEN = 8;

if (!fs.existsSync(SCOWL_PATH)) {
  console.error(`Missing ${SCOWL_PATH}.`);
  console.error('Download it with:');
  console.error('  curl -sL "http://app.aspell.net/create?max_size=60&spelling=US&max_variant=0&diacritic=both&special=hacker&special=roman-numerals&download=wordlist&encoding=utf-8&format=inline" -o assets/blossom/scowl-60.txt');
  process.exit(1);
}

// Slurs and strong profanity are curated out of the source lists rather than
// kept in a standing blocklist here — so re-apply that curation if you re-fetch
// SCOWL. The only filtering below is the algorithmic proper-noun drop.
const raw = fs.readFileSync(SCOWL_PATH, 'utf8').split('\n');
const valid = new Set();
const onlyLowerLetters = /^[a-z]+$/;

let started = false; // SCOWL prepends a license header, then a `---` separator.
for (const line of raw) {
  const trimmed = line.trim();
  if (!started) {
    if (trimmed === '---') started = true;
    continue;
  }
  // Proper nouns are capitalized in the source (Paris, Obama, Aachen). Skip
  // them BEFORE lowercasing — that's the only signal distinguishing them. Words
  // that are also common nouns keep their separate lowercase entry (China/china,
  // March/march), so this drops only the proper-noun-only spellings.
  if (/^[A-Z]/.test(trimmed)) continue;
  const w = trimmed.toLowerCase();
  if (!onlyLowerLetters.test(w)) continue;
  if (w.length < MIN_LEN || w.length > MAX_LEN) continue;
  valid.add(w);
}

const gen = fs.readFileSync(WORD_BANK_PATH, 'utf8')
  .split('\n')
  .map(s => s.trim().toLowerCase())
  .filter(w => onlyLowerLetters.test(w))
  .filter(w => w.length >= GEN_MIN_LEN && w.length <= GEN_MAX_LEN);

const genSet = new Set(gen);
for (const w of genSet) valid.add(w);

// Validate-only additions: real words the game rejected that shouldn't become
// daily targets. Merged into validation, never into the gen pool.
if (fs.existsSync(EXTRA_PATH)) {
  fs.readFileSync(EXTRA_PATH, 'utf8')
    .split('\n')
    .map(s => s.trim().toLowerCase())
    .filter(w => onlyLowerLetters.test(w))
    .filter(w => w.length >= MIN_LEN && w.length <= MAX_LEN)
    .forEach(w => valid.add(w));
}

const validSorted = [...valid].sort();
const genSorted = [...genSet].sort();

const out = `// Word lists for Blossom. GENERATED — do not edit by hand.
// Regenerate with: node scripts/blossom-build-words.js
//   BLOSSOM_WORDS     = validation pool (SCOWL ESDB size 60, US English,
//                       lengths ${MIN_LEN}-${MAX_LEN}, plus all generation words
//                       and extra_words.txt).
//   BLOSSOM_GEN_WORDS = chain-generation pool (curated word_bank.txt,
//                       lengths ${GEN_MIN_LEN}-${GEN_MAX_LEN}).
// See scripts/blossom-build-words.js for source, license, and trade-offs.
// Each list ships as one newline-joined string, split at load — smaller on the
// wire and much cheaper for mobile JS engines to parse than a ~${Math.round(validSorted.length / 1000)}k-element
// array literal.
window.BLOSSOM_WORDS = ${JSON.stringify(validSorted.join('\n'))}.split("\\n");
window.BLOSSOM_GEN_WORDS = ${JSON.stringify(genSorted.join('\n'))}.split("\\n");
`;

fs.writeFileSync(OUT_PATH, out);

console.log(`Wrote ${OUT_PATH}`);
console.log(`  validation: ${validSorted.length} words`);
console.log(`  generation: ${genSorted.length} words`);
const byLen = {};
for (const w of validSorted) byLen[w.length] = (byLen[w.length] || 0) + 1;
console.log('  validation length distribution:');
for (const k of Object.keys(byLen).sort((a, b) => a - b)) console.log(`    ${k}: ${byLen[k]}`);
