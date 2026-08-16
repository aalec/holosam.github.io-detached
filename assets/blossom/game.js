(function () {
  const VALID = new Set(window.BLOSSOM_WORDS);
  const { toRC, idx, isAdjacent, generateBoard, seedForDate, dateKey } =
    window.BlossomGen;

  const MAX_WORD_LEN = 12; // longest word in the dictionary
  const WORD_CAP_OVER_TARGET = 25;

  const TODAY = new Date();
  const TODAY_KEY = dateKey(TODAY);
  // Bump the version when the generator changes so state referencing cells that
  // no longer exist on the new board is discarded.
  const STORAGE_KEY = "blossom-v2-" + TODAY_KEY;
  const BOARD = generateBoard(seedForDate(TODAY), window.BLOSSOM_GEN_WORDS);
  const LONGEST_WORD = BOARD.chain.reduce(
    (a, b) => (b.length > a.length ? b : a),
    "",
  );

  // Hide today's solution from a casual console peek — not a real lock, the
  // source still ships.
  try {
    delete window.BlossomGen;
    delete window.BLOSSOM_WORDS;
    delete window.BLOSSOM_GEN_WORDS;
  } catch {}

  function pruneOldDays() {
    try {
      // Iterate backwards — removeItem reindexes the remaining keys.
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith("blossom-v2-") && k !== STORAGE_KEY) {
          localStorage.removeItem(k);
        }
      }
    } catch {}
  }
  pruneOldDays();

  function freshState() {
    return {
      words: [], // [{word, cells: [idx,...]}]
      used: [BOARD.start],
      active: BOARD.start,
      done: false,
      // Today's bests, scoped to this board. Survive a Restart but reset each
      // new board.
      bestWords: null,
      maxTiles: 0,
    };
  }

  // Rebuild and verify a saved state against TODAY's board. The word list is the
  // source of truth; `used`/`active`/`done` are recomputed. Any inconsistency
  // (stale board, hand-edited or spoofed save) starts fresh.
  function validateState(s) {
    if (!s || !Array.isArray(s.words)) return null;
    const used = [BOARD.start];
    let anchor = BOARD.start; // where the next word must begin
    for (const w of s.words) {
      if (!w || typeof w.word !== "string" || !Array.isArray(w.cells))
        return null;
      const cells = w.cells;
      if (cells.length < 3 || cells.length > MAX_WORD_LEN) return null;
      if (cells[0] !== anchor) return null;
      for (let k = 0; k < cells.length; k++) {
        if (!BOARD.tiles.has(cells[k])) return null;
        if (k > 0 && !isAdjacent(cells[k - 1], cells[k])) return null;
      }
      if (cells.map(letterAt).join("") !== w.word) return null;
      if (!VALID.has(w.word)) return null;
      cells.forEach((c) => {
        if (!used.includes(c)) used.push(c);
      });
      anchor = cells[cells.length - 1];
    }
    const bestWords =
      typeof s.bestWords === "number" && s.bestWords > 0 ? s.bestWords : null;
    const maxTiles =
      typeof s.maxTiles === "number" && s.maxTiles > 0
        ? Math.min(s.maxTiles, BOARD.totalTiles)
        : 0;
    return {
      words: s.words,
      used,
      active: anchor,
      done: used.length >= BOARD.totalTiles,
      bestWords,
      maxTiles,
    };
  }

  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      const valid = validateState(s);
      if (valid) return valid;
    } catch {}
    return freshState();
  }
  let state = loadState();

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
  }

  // Cross-day records, not date-scoped: streak plus lifetime stats (word/tile
  // bests are per-board, in the daily `state`). `dist` buckets each day's best
  // result against the board's word target; `lastBucket` remembers which bucket
  // today's win landed in so a same-day improvement can move it.
  const RECORDS_KEY = "blossom-records-v2";
  function loadRecords() {
    const defaults = {
      streak: 0,
      lastWinKey: null,
      wins: 0,
      bestStreak: 0,
      preStatsWins: 0,
      lastBucket: null,
      dist: { under: 0, on: 0, over: 0 },
      bestWordLen: 0,
    };
    try {
      const r = JSON.parse(localStorage.getItem(RECORDS_KEY) || "null");
      if (r && typeof r === "object") {
        const merged = {
          ...defaults,
          ...r,
          dist: { ...defaults.dist, ...r.dist },
        };
        // Stats shipped after streaks did. Credit an existing streak as wins so
        // a long-time player doesn't open the stats page to a zero. Their
        // per-day scores are gone, so the distribution stays empty and the
        // stats modal footnotes the difference. Recomputed (identically) on
        // every load until the first saveRecords persists `wins`.
        if (r.wins === undefined && merged.streak > 0) {
          merged.wins = merged.streak;
          merged.bestStreak = merged.streak;
          merged.preStatsWins = merged.streak;
        }
        return merged;
      }
    } catch {}
    return { ...defaults };
  }
  // The date key for the day before `key` (YYYY-MM-DD), for streak continuity.
  function prevDateKey(key) {
    const [y, m, d] = key.split("-").map(Number);
    return dateKey(new Date(y, m - 1, d - 1));
  }
  let records = loadRecords();
  function saveRecords() {
    try {
      localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
    } catch {}
  }
  function bucketFor(words) {
    if (words < BOARD.targetWords) return "under";
    if (words === BOARD.targetWords) return "on";
    return "over";
  }
  function updateRecords(tilesUsed) {
    if (tilesUsed > state.maxTiles) state.maxTiles = tilesUsed;
    // Every submitted word counts toward the longest-word record, not just
    // words on winning boards.
    const lastWord = state.words[state.words.length - 1];
    if (lastWord && lastWord.word.length > records.bestWordLen) {
      records.bestWordLen = lastWord.word.length;
      saveRecords();
    }
    if (!state.done || tilesUsed < BOARD.totalTiles) return;
    const improved =
      state.bestWords === null || state.words.length < state.bestWords;
    if (improved) state.bestWords = state.words.length;
    // Guard on lastWinKey so re-winning the same day can't double-count the
    // streak, wins, or distribution.
    if (records.lastWinKey !== TODAY_KEY) {
      records.streak =
        records.lastWinKey === prevDateKey(TODAY_KEY) ? records.streak + 1 : 1;
      records.bestStreak = Math.max(records.bestStreak, records.streak);
      records.lastWinKey = TODAY_KEY;
      records.wins += 1;
      records.lastBucket = bucketFor(state.bestWords);
      records.dist[records.lastBucket] += 1;
      saveRecords();
    } else if (improved) {
      // A redo can beat the earlier win; move today's result to its new
      // bucket rather than counting the day twice.
      const bucket = bucketFor(state.bestWords);
      if (bucket !== records.lastBucket) {
        if (records.dist[records.lastBucket] > 0) {
          records.dist[records.lastBucket] -= 1;
        }
        records.dist[bucket] += 1;
        records.lastBucket = bucket;
        saveRecords();
      }
    }
  }

  // ─── DOM scaffolding ───────────────────────────────────────────────────────
  const root = document.getElementById("blossom-game");
  root.innerHTML = `
    <div class="bl-container">
      <div class="bl-header-row">
        <div class="bl-date">Blossom ${TODAY_KEY}</div>
        <div class="bl-header-actions">
          <button class="bl-help bl-icon-btn" id="bl-hint-btn" aria-label="Hint" title="Hint">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 18h6"/>
              <path d="M10 22h4"/>
              <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V18h6v-1.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"/>
            </svg>
          </button>
          <button class="bl-help bl-icon-btn" id="bl-share" aria-label="Share" title="Share">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3v13"/>
              <path d="M6 9l6-6 6 6"/>
              <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>
            </svg>
          </button>
          <button class="bl-help bl-icon-btn" id="bl-stats-btn" aria-label="Stats" title="Stats">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="20" x2="18" y2="10"/>
              <line x1="12" y1="20" x2="12" y2="4"/>
              <line x1="6" y1="20" x2="6" y2="14"/>
            </svg>
          </button>
          <button class="bl-help bl-icon-btn" id="bl-help-btn" aria-label="How to play" title="How to play">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="bl-words" id="bl-words"></div>
      <div class="bl-current" id="bl-current" aria-live="polite" aria-atomic="true">&nbsp;</div>
      <div class="bl-grid-wrap">
        <div class="bl-grid-aspect" id="bl-grid-aspect">
          <svg id="bl-grid" class="bl-grid" xmlns="http://www.w3.org/2000/svg"></svg>
        </div>
      </div>
      <div class="bl-toast" id="bl-toast" role="status" aria-live="polite" aria-atomic="true"></div>
      <div class="bl-buttons">
        <button class="bl-btn" id="bl-delete">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 5H9l-6 7 6 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/>
            <line x1="18" y1="9.5" x2="12.5" y2="14.5"/>
            <line x1="12.5" y1="9.5" x2="18" y2="14.5"/>
          </svg>
          Delete
        </button>
        <button class="bl-btn" id="bl-restart">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="1 4 1 10 7 10"/>
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
          </svg>
          Restart
        </button>
        <button class="bl-btn bl-btn--primary" id="bl-enter">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="9 10 4 15 9 20"/>
            <path d="M20 4v7a4 4 0 0 1-4 4H4"/>
          </svg>
          Enter
        </button>
      </div>
      <div class="bl-modal" id="bl-modal" hidden>
        <div class="bl-modal-card" role="dialog" aria-modal="true" aria-labelledby="bl-modal-title">
          <button class="bl-modal-close" id="bl-modal-close" aria-label="Close">×</button>
          <h2 id="bl-modal-title">How to play</h2>
          <div class="bl-demo" aria-hidden="true">
            <div class="bl-demo-words" id="bl-demo-words"></div>
            <div class="bl-demo-current" id="bl-demo-current"></div>
            <svg id="bl-demo-svg" class="bl-demo-grid" xmlns="http://www.w3.org/2000/svg"></svg>
            <p class="bl-demo-caption" id="bl-demo-caption"></p>
          </div>
          <ol>
            <li>Start at the highlighted tile. Tap or drag across adjacent tiles to spell a word, then hit Enter. Each new word begins where the last one ended.</li>
            <li>Tiles can be used again, both within a word and across words. Keep linking words until every tile is used. Aim for as few words as you can.</li>
            <li>Delete undoes one letter. On a keyboard, arrows move between tiles, Space picks one, Enter submits and Delete undoes. If you're stuck, tap 💡 for a hint.</li>
          </ol>
          <p class="bl-modal-foot">The board resets at midnight, so come back tomorrow to play a new one!</p>
          <p class="bl-modal-foot"><a href="/posts/blossom/">Read the story behind Blossom</a>.</p>
        </div>
      </div>
      <div class="bl-modal" id="bl-stats" hidden>
        <div class="bl-modal-card" role="dialog" aria-modal="true" aria-labelledby="bl-stats-title">
          <button class="bl-modal-close" id="bl-stats-close" aria-label="Close">×</button>
          <h2 id="bl-stats-title">Stats</h2>
          <div class="bl-stat-tiles" id="bl-stat-tiles"></div>
          <div class="bl-stat-bars" id="bl-stat-bars"></div>
          <div class="bl-stats-badges" id="bl-stats-badges"></div>
        </div>
      </div>
      <div class="bl-modal" id="bl-confirm" hidden>
        <div class="bl-modal-card" role="dialog" aria-modal="true" aria-labelledby="bl-confirm-title">
          <p id="bl-confirm-title">Are you sure you want to restart?</p>
          <label class="bl-confirm-check">
            <input type="checkbox" id="bl-confirm-skip" />
            Don't ask again
          </label>
          <div class="bl-confirm-actions">
            <button class="bl-btn" id="bl-confirm-cancel">Cancel</button>
            <button class="bl-btn bl-btn--primary" id="bl-confirm-ok">Restart</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // ─── SVG hex grid ──────────────────────────────────────────────────────────
  const HEX_SIZE = 34; // tile radius; CSS scales for mobile
  const HEX_W = Math.sqrt(3) * HEX_SIZE;
  const HEX_H = 1.5 * HEX_SIZE;

  function cellXY(i) {
    const [r, c] = toRC(i);
    return { x: c * HEX_W + r * HEX_W * 0.5, y: r * HEX_H };
  }

  function hexPoints(cx, cy) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + (Math.PI / 3) * i;
      pts.push(`${cx + HEX_SIZE * Math.cos(a)},${cy + HEX_SIZE * Math.sin(a)}`);
    }
    return pts.join(" ");
  }

  // Shared by the game grid and the how-to demo: compute a tight viewBox
  // around `tilesMap` and add one hex group per tile. Returns the groups
  // keyed by cell, plus the viewBox size.
  function buildHexes(svg, tilesMap, pad) {
    const SVG_NS = "http://www.w3.org/2000/svg";

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const i of tilesMap.keys()) {
      const { x, y } = cellXY(i);
      minX = Math.min(minX, x - HEX_SIZE);
      maxX = Math.max(maxX, x + HEX_SIZE);
      minY = Math.min(minY, y - HEX_SIZE);
      maxY = Math.max(maxY, y + HEX_SIZE);
    }
    const vbW = maxX - minX + pad.left + pad.right;
    const vbH = maxY - minY + pad.top + pad.bottom;
    svg.setAttribute(
      "viewBox",
      `${minX - pad.left} ${minY - pad.top} ${vbW} ${vbH}`,
    );

    const els = new Map();
    // Render top-down so a lifted hex always paints over the row above it.
    // (SVG has no z-index; later siblings paint on top.)
    const sortedTiles = [...tilesMap.entries()].sort(
      ([a], [b]) => toRC(a)[0] - toRC(b)[0],
    );
    for (const [i, letter] of sortedTiles) {
      const { x, y } = cellXY(i);

      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("class", "bl-hex");

      const poly = document.createElementNS(SVG_NS, "polygon");
      poly.setAttribute("points", hexPoints(x, y));

      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", x);
      text.setAttribute("y", y + 1);
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "central");
      text.textContent = letter.toUpperCase();

      g.appendChild(poly);
      g.appendChild(text);
      svg.appendChild(g);
      els.set(i, g);
    }
    return { els, vbW, vbH };
  }

  function buildGrid() {
    const svg = document.getElementById("bl-grid");
    const { els, vbW, vbH } = buildHexes(svg, BOARD.tiles, {
      left: 4,
      right: 4,
      top: 4,
      bottom: 4,
    });
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    // Give the wrapper the aspect ratio so CSS can size the grid against both
    // viewport width and height; aspect-ratio fixes the box, so animation
    // transforms can overflow without resizing it (see games.css).
    const aspect = document.getElementById("bl-grid-aspect");
    aspect.style.setProperty("--bl-aspect", `${vbW / vbH}`);

    for (const [i, g] of els) {
      g.setAttribute("data-i", i);
      // Roving tabindex: render() promotes the current entry tile to 0 so Tab
      // enters the grid at one stop, not 21.
      g.setAttribute("role", "button");
      g.setAttribute("tabindex", "-1");
      // Per-element listeners rather than one delegated handler on the SVG:
      // reading the focused tile back off document.activeElement is unreliable
      // for SVG nodes across browsers, so bind directly and close over `i`.
      g.addEventListener("click", () => {
        // A drag that added tiles ends with a synthetic click on the origin
        // tile — swallow it so it doesn't also tap-toggle.
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        onTileClick(i);
      });
      g.addEventListener("keydown", (e) => onTileKey(e, i));
      g.addEventListener("pointerdown", (e) => onTilePointerDown(e, i));
    }
  }

  // ─── Current selection ─────────────────────────────────────────────────────
  // selection[0] is always state.active (start of in-progress word).
  let selection = [state.active];

  function letterAt(i) {
    return BOARD.tiles.get(i);
  }

  function currentWord() {
    return selection.map(letterAt).join("");
  }

  function onTileClick(i) {
    if (state.done) return;
    if (!BOARD.tiles.has(i)) return;

    // Tapping the most-recently-selected tile undoes it.
    if (i === selection[selection.length - 1] && selection.length > 1) {
      selection.pop();
      render();
      return;
    }

    if (selection.length >= MAX_WORD_LEN) return;

    // Any tile adjacent to the last selected can be added — including one
    // already in the selection, since letters can be reused within a word
    // (e.g. LEAVE walks back over the first E).
    const last = selection[selection.length - 1];
    if (!isAdjacent(last, i)) return;

    selection.push(i);
    render();
  }

  // ─── Keyboard navigation ─────────────────────────────────────────────────
  // SVG groups, unlike real <button>s, don't fire a click on Space, so it's
  // wired explicitly. Focus only follows a change, so a rejected Space leaves
  // the cursor put instead of yanking it to the active tile.
  //
  // Space picks a letter; Enter and Delete are board-wide (see onGameKey) and
  // deliberately not handled here, so they mean the same thing whether or not a
  // tile happens to hold focus.
  const ARROW_DIRS = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };

  function onTileKey(e, i) {
    if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      const before = selection.length;
      onTileClick(i);
      if (selection.length !== before) {
        focusTile(selection[selection.length - 1]);
      }
      return;
    }
    const dir = ARROW_DIRS[e.key];
    if (!dir) return;
    e.preventDefault();
    const next = nearestTile(i, dir);
    if (next != null) focusTile(next);
  }

  // Closest tile within a ~60° cone of the pressed direction. Geometric rather
  // than neighbor-based, so four arrow keys map cleanly onto a six-neighbour hex
  // grid and skip over gaps to the next real tile.
  //
  // Tie-breaking matters: on this lattice the due-east and up-right neighbours
  // sit at the *same* distance, so "nearest" alone is a coin flip between them.
  // We rank candidates by, in order:
  //   1. nearest (one step, not a far jump),
  //   2. best aligned to the pressed direction (→ favours due-east over up-right),
  //   3. larger signed perpendicular `cross` — i.e. the same side of the arrow.
  // That last rule keeps each axis self-consistent AND makes opposite arrows
  // exact inverses: ↑ takes the left of the two upper tiles, ↓ the right of the
  // two lower tiles, so ↑ then ↓ returns to the tile you started on.
  function nearestTile(from, [dx, dy]) {
    const a = cellXY(from);
    let best = null;
    let bestDist = Infinity;
    let bestAlign = -Infinity;
    let bestCross = -Infinity;
    for (const j of BOARD.tiles.keys()) {
      if (j === from) continue;
      const b = cellXY(j);
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const dist = Math.hypot(vx, vy);
      const align = (vx * dx + vy * dy) / dist; // cosine to the pressed direction
      if (align < 0.5) continue; // behind, or outside the ~60° cone
      const cross = vx * dy - vy * dx; // signed offset perpendicular to the arrow

      let better;
      if (Math.abs(dist - bestDist) > 0.5) {
        better = dist < bestDist; // different lattice ring: pure distance
      } else if (Math.abs(align - bestAlign) > 1e-6) {
        better = align > bestAlign; // same ring: prefer the better-aligned tile
      } else {
        better = cross > bestCross; // genuine tie: pick a consistent side
      }
      if (better) {
        best = j;
        bestDist = dist;
        bestAlign = align;
        bestCross = cross;
      }
    }
    return best;
  }

  function focusTile(i) {
    const g = document.querySelector(`#bl-grid .bl-hex[data-i="${i}"]`);
    if (!g) return;
    document
      .querySelectorAll("#bl-grid .bl-hex")
      .forEach((el) => el.setAttribute("tabindex", "-1"));
    g.setAttribute("tabindex", "0");
    g.focus();
  }

  // ─── Drag to select ────────────────────────────────────────────────────────
  // A press becomes a drag once the pointer crosses onto a different tile;
  // a plain tap ends without moving, and the browser's click event drives the
  // tap path above. Drags only ever ADD letters — no retrace-to-undo — because
  // dragging back over a previous tile is how letters are reused (e.g. the
  // second A in CANAL). Undo stays on tap-the-last-tile and Delete.
  // (Requires touch-action: none on the grid — see games.css.)
  let drag = null;
  let suppressClick = false;

  // Hit-test against a disc smaller than the hex, leaving a dead zone between
  // tiles so a finger wobbling along a shared edge can't ping-pong letters in.
  function tileFromEvent(e) {
    const svg = document.getElementById("bl-grid");
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    for (const i of BOARD.tiles.keys()) {
      const { x, y } = cellXY(i);
      if (Math.hypot(p.x - x, p.y - y) <= HEX_SIZE * 0.72) return i;
    }
    return null;
  }

  // Like onTileClick, minus the tap-to-undo branch: mid-drag, revisiting the
  // last tile must be a no-op, not a toggle.
  function dragAdd(i) {
    if (state.done) return;
    if (selection.length >= MAX_WORD_LEN) return;
    const last = selection[selection.length - 1];
    if (i === last || !isAdjacent(last, i)) return;
    selection.push(i);
    render();
  }

  function onTilePointerDown(e, i) {
    suppressClick = false;
    if (state.done) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    drag = { pointerId: e.pointerId, visited: i, moved: false };
  }

  document.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const i = tileFromEvent(e);
    if (i === null || i === drag.visited) return;
    if (!drag.moved) {
      drag.moved = true;
      // The press is now a drag, so commit the pressed tile — unless it's
      // already the head of the selection (starting a drag from the active
      // tile must not toggle it the way a tap would).
      if (drag.visited !== selection[selection.length - 1])
        dragAdd(drag.visited);
    }
    dragAdd(i);
    drag.visited = i;
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    suppressClick = drag.moved;
    drag = null;
  }
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);

  function tileStatus(i, selSet, usedSet, anchor, lastSel) {
    if (i === anchor) return "start of current word";
    if (selSet.has(i))
      return i === lastSel ? "current letter" : "in current word";
    if (usedSet.has(i)) return "bloomed";
    return "unbloomed";
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────
  // Shared by the game grid and the how-to demo, so the demo always shows the
  // exact tile states a player will see. Returns whether the tile is reachable.
  function paintTile(el, i, { selSet, usedSet, lastSel, anchor, multi, done }) {
    el.classList.remove(
      "bl-used",
      "bl-unused",
      "bl-sel",
      "bl-active",
      "bl-anchor",
      "bl-adj",
      "bl-filled",
    );

    if (selSet.has(i)) {
      el.classList.add("bl-sel");
      if (i === lastSel && multi) el.classList.add("bl-active");
      if (i === anchor) el.classList.add("bl-anchor");
    } else if (usedSet.has(i)) {
      el.classList.add("bl-used");
    } else {
      el.classList.add("bl-unused");
    }

    // The "filled" border tracks used tiles regardless of interaction state,
    // so a re-used tile keeps the cue while fresh picks in the current word
    // stay thin.
    if (usedSet.has(i)) el.classList.add("bl-filled");

    const reachable = !done && isAdjacent(lastSel, i);
    if (reachable) {
      el.classList.add("bl-adj");
    }
    return reachable;
  }

  function render() {
    const usedSet = new Set(state.used);
    const selSet = new Set(selection);
    const lastSel = selection[selection.length - 1];
    const anchor = selection[0];
    const ctx = {
      selSet,
      usedSet,
      lastSel,
      anchor,
      multi: selection.length > 1,
      done: state.done,
    };

    document.querySelectorAll("#bl-grid .bl-hex").forEach((el) => {
      const i = parseInt(el.getAttribute("data-i"), 10);
      const reachable = paintTile(el, i, ctx);

      const hint = reachable && !selSet.has(i) ? ", press Space to add" : "";
      el.setAttribute(
        "aria-label",
        `${letterAt(i).toUpperCase()}, ${tileStatus(i, selSet, usedSet, anchor, lastSel)}${hint}`,
      );
      el.setAttribute("aria-pressed", selSet.has(i) ? "true" : "false");
      el.setAttribute("tabindex", i === lastSel ? "0" : "-1");
    });

    const cw = document.getElementById("bl-current");
    cw.textContent = currentWord() || " ";

    const wl = document.getElementById("bl-words");
    // The goal nudge shows only on a fresh board; once play starts, the tiles
    // and word-chain convey progress.
    const wordCount = state.words.length;
    const statusTxt =
      wordCount === 0
        ? `Use every tile to win. Aim for ${BOARD.targetWords} words (or fewer) if you can.`
        : "";

    wl.innerHTML = `
      <div class="bl-par">${statusTxt}</div>
      <div class="bl-word-chain">
        ${state.words.map((w) => `<span class="bl-word-chip">${w.word.toUpperCase()}</span>`).join('<span class="bl-word-sep">›</span>')}
      </div>
    `;

    if (state.done) {
      // The praise word is the only score signal, scaling with how few words it
      // took.
      const text =
        wordCount < BOARD.targetWords
          ? `Incredible!`
          : wordCount === BOARD.targetWords
            ? `Amazing!`
            : `Nice!`;
      const streak =
        records.streak > 0 ? `🔥 ${records.streak} day streak` : "";
      const meta = [
        streak,
        `<button type="button" class="bl-banner-share" id="bl-banner-share">Share your high score</button>`,
      ]
        .filter(Boolean)
        .join(" · ");
      cw.innerHTML =
        `<span class="bl-done-banner">${text}` +
        `<span class="bl-banner-meta"> · ${meta}</span></span>`;
      const sb = document.getElementById("bl-banner-share");
      if (sb) sb.addEventListener("click", share);
    }
  }

  // ─── Toast ─────────────────────────────────────────────────────────────────
  let toastTimer;
  // tone "info" reads neutral so hints/success don't masquerade as rejections.
  function toast(msg, { tone = "error", ms = 1600 } = {}) {
    const el = document.getElementById("bl-toast");
    el.textContent = msg;
    el.classList.toggle("bl-toast--info", tone === "info");
    el.classList.add("bl-toast--on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("bl-toast--on"), ms);
  }

  // ─── Submit ────────────────────────────────────────────────────────────────
  function submit() {
    if (state.done) return;
    if (selection.length < 3) {
      toast("Words must be at least 3 letters");
      return;
    }
    const word = currentWord();
    if (!VALID.has(word)) {
      toast(`"${word.toUpperCase()}" not in dictionary`);
      return;
    }
    // Anti-abuse ceiling only. Refuse the word rather than ending the round, so
    // there's no fail state.
    if (state.words.length >= BOARD.targetWords + WORD_CAP_OVER_TARGET) {
      toast("Word limit reached");
      return;
    }

    const cells = selection.slice();
    const wasDone = state.done;
    state.words.push({ word, cells });
    cells.forEach((c) => {
      if (!state.used.includes(c)) state.used.push(c);
    });
    state.active = cells[cells.length - 1];
    selection = [state.active];

    const won = state.used.length >= BOARD.totalTiles;
    if (won) state.done = true;
    updateRecords(state.used.length);
    save();
    render();
    bloomCells(cells);
    if (!wasDone && won) {
      // Stagger the cascade so the entered word finishes blooming first
      setTimeout(victoryCascade, cells.length * 55 + 200);
    }
  }

  // Pop a single tile after `delay`ms: add the class, remove it a beat later so
  // the CSS transition settles back (see games.css).
  const BLOOM_MS = 300;
  function popEl(el, className, delay) {
    if (!el) return;
    setTimeout(() => {
      el.classList.add(className);
      setTimeout(() => el.classList.remove(className), BLOOM_MS);
    }, delay);
  }
  function popTile(cell, className, delay) {
    popEl(
      document.querySelector(`#bl-grid .bl-hex[data-i="${cell}"]`),
      className,
      delay,
    );
  }

  function bloomCells(cells) {
    cells.forEach((c, i) => popTile(c, "bl-bloom", i * 55));
  }

  // Concentric ring bloom from the start tile — never traces a path, so it
  // can't accidentally reveal the generator's intended chain. All tiles in
  // the same ring fire simultaneously; rings fire 130ms apart.
  function victoryCascade() {
    const startP = cellXY(BOARD.start);
    const rings = new Map();
    for (const c of BOARD.tiles.keys()) {
      const p = cellXY(c);
      const d = Math.round(Math.hypot(p.x - startP.x, p.y - startP.y) / HEX_W);
      if (!rings.has(d)) rings.set(d, []);
      rings.get(d).push(c);
    }
    const dists = [...rings.keys()].sort((a, b) => a - b);
    dists.forEach((d, ringIdx) => {
      const delay = ringIdx * 130;
      for (const c of rings.get(d)) popTile(c, "bl-victory", delay);
    });
  }

  // Drop the last selected letter, or if none past the anchor, un-enter the last
  // word and re-select all but its final letter (to swap it). Stays live after a
  // win so the player can rework the tail for a lower word count.
  function deleteLast() {
    if (selection.length > 1) {
      selection.pop();
      render();
      return;
    }
    if (state.words.length === 0) return;
    const last = state.words.pop();
    // Rebuild `used` from scratch — a cell from the popped word might still
    // be covered by an earlier word, so we can't just subtract.
    state.used = [BOARD.start];
    state.words.forEach((w) =>
      w.cells.forEach((c) => {
        if (!state.used.includes(c)) state.used.push(c);
      }),
    );
    state.active = last.cells[0];
    selection = last.cells.slice(0, -1);
    state.done = false;
    save();
    render();
  }

  function showHint() {
    toast(`The word ${LONGEST_WORD.toUpperCase()} is possible today`, {
      tone: "info",
      ms: 3500,
    });
  }

  // Build the shareable score string. After a completion it shares today's BEST
  // (fewest-word) win, not whatever redo is on the board. The bouquet:
  //   🌸 word entered   ⚪ open target slot   🏆 words under target
  //   🌿 word past target (overshoot is fine — the goal is filling the board)
  function shareText() {
    const target = BOARD.targetWords;
    // bestWords is only set on a full-board win, so non-null means completed today.
    const won = state.bestWords !== null;
    const used = won ? state.bestWords : state.words.length;
    const tilesUsed = won
      ? BOARD.totalTiles
      : new Set([BOARD.start, ...state.words.flatMap((w) => w.cells)]).size;
    const blooms = Math.min(used, target);
    const filler = Math.max(0, target - used);
    // Cap the overshoot run so a runaway count can't balloon the share text.
    const extras = Math.min(Math.max(0, used - target), 10);
    const fillerChar = won ? "🏆" : "⚪";
    const bouquet =
      "🌸".repeat(blooms) + fillerChar.repeat(filler) + "🌿".repeat(extras);
    const line = won
      ? bouquet
      : `${bouquet} ${tilesUsed}/${BOARD.totalTiles} tiles`;
    const header =
      records.streak > 0
        ? `Blossom ${TODAY_KEY} · 🔥 ${records.streak}`
        : `Blossom ${TODAY_KEY}`;
    return `${header}\n${line}`;
  }

  // Last-resort copy for browsers without the async clipboard API: a hidden
  // textarea + execCommand.
  function copyFallback(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      toast(ok ? "Copied to clipboard" : "Couldn't copy — try again", {
        tone: ok ? "info" : "error",
      });
    } catch {
      toast("Couldn't copy — try again");
    }
  }

  function share() {
    const text = shareText();
    // On touch devices the native share sheet is the expected flow (one tap to
    // the group chat); desktop gets the clipboard.
    if (matchMedia("(pointer: coarse)").matches && navigator.share) {
      // Rejects if the user dismisses the sheet — nothing to report there.
      navigator.share({ text }).catch(() => {});
      return;
    }
    // `navigator.clipboard` is undefined in non-secure contexts and some in-app
    // browsers, and accessing .writeText there throws synchronously (a .catch()
    // wouldn't catch it) — so guard it, then fall back to the share sheet, then
    // a manual copy.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => toast("Copied to clipboard", { tone: "info" }))
        .catch(() => toast("Couldn't copy — try again"));
      return;
    }
    if (navigator.share) {
      navigator.share({ text }).catch(() => {});
      return;
    }
    copyFallback(text);
  }

  function restart() {
    const { bestWords, maxTiles } = state;
    state = freshState();
    // Bests persist across Restart so a redo can be measured against earlier.
    state.bestWords = bestWords;
    state.maxTiles = maxTiles;
    selection = [state.active];
    save();
    render();
  }

  // ─── Wire up ───────────────────────────────────────────────────────────────
  buildGrid();
  render();

  document.getElementById("bl-enter").addEventListener("click", submit);
  document.getElementById("bl-delete").addEventListener("click", deleteLast);

  // Enter submits and Delete/Backspace undoes, wherever focus sits — they act
  // on the word, not on a tile, so binding them to the grid would make them
  // work only after the player had tabbed into it.
  //
  // Skipped when a native control has focus, since Enter and Space already
  // click a focused <button> and Backspace edits a focused field; without this,
  // Enter on the Restart button would restart *and* submit. Also skipped while
  // a modal is open, where the same keys belong to the dialog.
  function onGameKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && t.closest && t.closest("button, a, input, textarea, select")) {
      return;
    }
    if (document.querySelector(".bl-modal:not([hidden])")) return;

    if (e.key === "Enter") {
      e.preventDefault();
      const anchor = selection[0];
      submit();
      // Follow the chain to the new word's start tile, but only if the grid
      // held focus — otherwise leave the page's focus where the player put it.
      if (inGrid(t) && selection[0] !== anchor) focusTile(selection[0]);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      // Backspace is browser "back" on a page with no focused field.
      e.preventDefault();
      deleteLast();
      if (inGrid(t)) focusTile(selection[selection.length - 1]);
    }
  }

  function inGrid(el) {
    return !!(el && el.closest && el.closest("#bl-grid"));
  }

  document.addEventListener("keydown", onGameKey);
  document.getElementById("bl-share").addEventListener("click", share);
  document.getElementById("bl-hint-btn").addEventListener("click", showHint);

  // ─── Modal focus management ────────────────────────────────────────────────
  // Move focus into the dialog on open, trap Tab inside it, close on Escape, and
  // hand focus back to whatever opened it on close.
  let modalReturnFocus = null;
  function modalFocusables(overlay) {
    return [
      ...overlay.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => !el.disabled && el.offsetParent !== null);
  }
  function openModal(overlay) {
    modalReturnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    overlay.hidden = false;
    const f = modalFocusables(overlay);
    (f[0] || overlay).focus();
  }
  function closeModal(overlay) {
    overlay.hidden = true;
    if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
    modalReturnFocus = null;
  }
  function wireModalKeys(overlay) {
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeModal(overlay);
        return;
      }
      if (e.key !== "Tab") return;
      const f = modalFocusables(overlay);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      // Wrap focus at the ends so Tab can't escape to the page behind.
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  // Restart confirms first, unless the player opted out via the dialog's "Don't
  // ask again" checkbox.
  const RESTART_NOCONFIRM_KEY = "blossom-restart-noconfirm";
  const confirmModal = document.getElementById("bl-confirm");
  function requestRestart() {
    let noConfirm = false;
    try {
      noConfirm = !!localStorage.getItem(RESTART_NOCONFIRM_KEY);
    } catch {}
    if (noConfirm) {
      restart();
      return;
    }
    document.getElementById("bl-confirm-skip").checked = false;
    openModal(confirmModal);
  }
  wireModalKeys(confirmModal);
  document
    .getElementById("bl-restart")
    .addEventListener("click", requestRestart);
  document
    .getElementById("bl-confirm-cancel")
    .addEventListener("click", () => closeModal(confirmModal));
  document.getElementById("bl-confirm-ok").addEventListener("click", () => {
    if (document.getElementById("bl-confirm-skip").checked) {
      try {
        localStorage.setItem(RESTART_NOCONFIRM_KEY, "1");
      } catch {}
    }
    closeModal(confirmModal);
    restart();
  });
  confirmModal.addEventListener("click", (e) => {
    if (e.target === confirmModal) closeModal(confirmModal);
  });

  // ─── Stats modal ───────────────────────────────────────────────────────────
  // Buckets are labeled with the win banner's praise words, not golf terms,
  // and deliberately never explained (no tooltips/subtext): discovering what
  // earns each tier — and the locked under-goal row — is part of the game.
  function renderStats() {
    // `streak` in storage only resets on the next win, so it reads stale-high
    // after a missed day — zero it for display if the chain is already broken.
    const alive =
      records.lastWinKey === TODAY_KEY ||
      records.lastWinKey === prevDateKey(TODAY_KEY);
    document.getElementById("bl-stat-tiles").innerHTML = [
      [records.wins, "Wins"],
      [alive ? records.streak : 0, "Streak"],
      [records.bestStreak, "Best streak"],
    ]
      .map(
        ([n, label]) =>
          `<div class="bl-stat"><div class="bl-stat-num">${n}</div><div class="bl-stat-label">${label}</div></div>`,
      )
      .join("");

    const max = Math.max(
      1,
      records.dist.under,
      records.dist.on,
      records.dist.over,
    );
    const bar = (label, emoji, n) =>
      `<span class="bl-bar-label">${label} ${emoji}</span>` +
      `<span class="bl-bar-track">${
        n > 0
          ? `<span class="bl-bar-fill" style="width:max(${Math.round((n / max) * 100)}%, 6px)"></span>`
          : ""
      }</span>` +
      `<span class="bl-bar-count${n === 0 ? " bl-bar-count--zero" : ""}">${n}</span>`;
    document.getElementById("bl-stat-bars").innerHTML =
      (records.dist.under > 0
        ? bar("Incredible", "🏆", records.dist.under)
        : `<span class="bl-bar-label bl-bar-locked">??? 🔒</span>` +
          `<span class="bl-bar-track"></span><span class="bl-bar-count"></span>`) +
      bar("Amazing", "🌸", records.dist.on) +
      bar("Nice", "🌿", records.dist.over);

    const badges = [
      [
        records.preStatsWins > 0,
        "🌱",
        "Early Bloomer",
        "Had a win before stats existed",
      ],
      [records.bestStreak >= 7, "🪴", "Green Thumb", "Kept a 7-day streak"],
      [records.bestStreak >= 30, "🌻", "Perennial", "Kept a 30-day streak"],
      [records.wins >= 100, "💐", "Bouquet", "Won 100 boards"],
      [
        records.dist.under >= 10,
        "🌺",
        "Rare Bloom",
        "Beat the word goal 10 times",
      ],
      [records.bestWordLen >= 9, "🦋", "Pollinator", "Played a 9+ letter word"],
    ];
    document.getElementById("bl-stats-badges").innerHTML = badges
      .filter(([earned]) => earned)
      .map(
        ([, emoji, name, desc]) =>
          `<span class="bl-badge-pill">${emoji} <strong>${name}</strong> · ${desc}</span>`,
      )
      .join("");
  }

  const statsModal = document.getElementById("bl-stats");
  wireModalKeys(statsModal);
  document.getElementById("bl-stats-btn").addEventListener("click", () => {
    renderStats();
    openModal(statsModal);
  });
  document
    .getElementById("bl-stats-close")
    .addEventListener("click", () => closeModal(statsModal));
  statsModal.addEventListener("click", (e) => {
    if (e.target === statsModal) closeModal(statsModal);
  });

  const modal = document.getElementById("bl-modal");
  wireModalKeys(modal);
  document.getElementById("bl-help-btn").addEventListener("click", openHelp);
  document
    .getElementById("bl-modal-close")
    .addEventListener("click", () => closeModal(modal));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal(modal);
  });

  // ─── How-to demo ───────────────────────────────────────────────────────────
  // A four-tile board inside the help modal that replays CAT → TEA on loop.
  // Tiles are painted through the same paintTile as the real board, so the
  // demo shows the game's exact visual language: the anchor border, lifted
  // adjacent tiles, the already-selected junction tile, and tile reuse.
  const DEMO_TILES = new Map([
    [idx(5, 5), "c"],
    [idx(5, 6), "a"],
    [idx(5, 7), "t"],
    [idx(6, 6), "e"],
  ]);
  const [DEMO_C, DEMO_A, DEMO_T, DEMO_E] = [...DEMO_TILES.keys()];
  const DEMO_WORD1 = [DEMO_C, DEMO_A, DEMO_T];

  const demoSvg = document.getElementById("bl-demo-svg");
  // Extra bottom padding leaves room for the finger below the lower row.
  const demoEls = buildHexes(demoSvg, DEMO_TILES, {
    left: 6,
    right: 6,
    top: 8,
    bottom: 14,
  }).els;
  const demoFinger = (function () {
    const finger = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "text",
    );
    finger.setAttribute("class", "bl-demo-finger");
    finger.textContent = "👆";
    demoSvg.appendChild(finger);
    return finger;
  })();

  function demoRender(sel, used, done) {
    const ctx = {
      selSet: new Set(sel),
      usedSet: new Set(used),
      lastSel: sel[sel.length - 1],
      anchor: sel[0],
      multi: sel.length > 1,
      done,
    };
    for (const [i, el] of demoEls) paintTile(el, i, ctx);
    document.getElementById("bl-demo-current").textContent = done
      ? ""
      : sel.map((c) => DEMO_TILES.get(c)).join("");
  }

  function demoChips(words) {
    document.getElementById("bl-demo-words").innerHTML = words
      .map((w) => `<span class="bl-word-chip">${w}</span>`)
      .join('<span class="bl-word-sep">›</span>');
  }

  function demoCaption(text) {
    document.getElementById("bl-demo-caption").textContent = text;
  }

  function demoFingerMove(i) {
    const { x, y } = cellXY(i);
    demoFinger.style.transform = `translate(${x + 10}px, ${y + 30}px)`;
  }
  function demoFingerTap(i) {
    demoFingerMove(i);
    demoFinger.classList.add("bl-demo-finger--on");
  }
  function demoFingerHide() {
    demoFinger.classList.remove("bl-demo-finger--on");
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Demo playback speed: 1 is the authored pace, higher is faster.
  const DEMO_SPEED = 1.2;
  demoFinger.style.transitionDuration = `${0.5 / DEMO_SPEED}s, 0.2s`;
  // Checking modal.hidden stops the loop when the modal closes; bumping demoRun
  // kills the stale loop still sleeping when the modal reopens.
  let demoRun = 0;
  async function runDemo() {
    const run = ++demoRun;
    const step = async (ms) => {
      await sleep(ms / DEMO_SPEED);
      return run === demoRun && !modal.hidden;
    };
    while (true) {
      demoChips([]);
      demoFingerHide();
      demoFingerMove(DEMO_C);
      demoRender([DEMO_C], [DEMO_C], false);
      demoCaption("Start at the highlighted tile.");
      if (!(await step(1700))) return;

      demoCaption("Tap adjacent tiles to spell a word…");
      demoFingerTap(DEMO_A);
      if (!(await step(700))) return;
      demoRender([DEMO_C, DEMO_A], [DEMO_C], false);
      if (!(await step(600))) return;
      demoFingerTap(DEMO_T);
      if (!(await step(700))) return;
      demoRender(DEMO_WORD1, [DEMO_C], false);
      demoFingerHide();
      if (!(await step(600))) return;

      demoCaption("…then hit Enter.");
      if (!(await step(900))) return;
      demoChips(["CAT"]);
      demoRender([DEMO_T], DEMO_WORD1, false);
      DEMO_WORD1.forEach((c, k) => popEl(demoEls.get(c), "bl-bloom", k * 55));
      if (!(await step(1400))) return;

      demoCaption(
        "The next word starts where the last one ended, so T is already selected.",
      );
      if (!(await step(2200))) return;

      demoCaption("Tiles you've already used can be used again…");
      demoFingerTap(DEMO_E);
      if (!(await step(700))) return;
      demoRender([DEMO_T, DEMO_E], DEMO_WORD1, false);
      if (!(await step(600))) return;
      demoFingerTap(DEMO_A);
      if (!(await step(700))) return;
      demoRender([DEMO_T, DEMO_E, DEMO_A], DEMO_WORD1, false);
      demoFingerHide();
      if (!(await step(900))) return;

      demoChips(["CAT", "TEA"]);
      demoRender([DEMO_A], [...DEMO_TILES.keys()], true);
      demoCaption("Fill every tile to win. Aim for as few words as you can!");
      [...DEMO_TILES.keys()].forEach((c, k) =>
        popEl(demoEls.get(c), "bl-victory", k * 80),
      );
      if (!(await step(3000))) return;
    }
  }

  function openHelp() {
    openModal(modal);
    runDemo();
  }

  // First-time players land on a bare grid with no rules — open the how-to once
  // so the chain mechanic is discoverable.
  const HELP_SEEN_KEY = "blossom-help-seen";
  let helpSeen = false;
  try {
    helpSeen = !!localStorage.getItem(HELP_SEEN_KEY);
  } catch {}
  if (!helpSeen) {
    openHelp();
    try {
      localStorage.setItem(HELP_SEEN_KEY, "1");
    } catch {}
  }

  // TODAY_KEY and BOARD are captured at module load. If a tab is left open
  // across midnight, the player would see yesterday's board with whatever
  // in-memory selection they had — reload when the date rolls over.
  function refreshIfStale() {
    if (dateKey(new Date()) !== TODAY_KEY) location.reload();
  }

  // Fingerprinting can't bust the HTML that carries the script URLs, so a
  // returning visitor can boot old code. BLOSSOM_BUILD is baked into that
  // (possibly stale) HTML; a mismatch with the fresh file means a newer deploy
  // exists.
  async function reloadIfCodeStale() {
    try {
      const res = await fetch("/blossom-version.txt", { cache: "no-store" });
      if (!res.ok) return;
      const latest = (await res.text()).trim();
      if (latest === window.BLOSSOM_BUILD) return;
      // pageshow fires again after the reload below, and the CDN can keep
      // serving the stale HTML for a while — without a guard that's
      // mismatch → reload → mismatch on repeat. One attempt per build id.
      const key = "blossom-reload-attempted";
      if (sessionStorage.getItem(key) === latest) return;
      sessionStorage.setItem(key, latest);
      location.reload();
    } catch {}
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshIfStale();
      reloadIfCodeStale();
    }
  });
  window.addEventListener("pageshow", () => {
    refreshIfStale();
    reloadIfCodeStale();
  });
  // visibilitychange/pageshow miss a tab left focused across midnight, so also
  // poll the date once a minute.
  setInterval(refreshIfStale, 60000);
})();
