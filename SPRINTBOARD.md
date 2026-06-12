# SPRINTBOARD

Roadmap = the to-do list. Check items off as they land, append to the
changelog each session, and keep design decisions current. Next sprint is
always the top unchecked milestone. Update after tests and RFEs, and
always before pushes.

## Status — 2026-06-12

Session 1: scaffold + **M1 done** (core grid, browser-verified) +
**M2 core done** (live bidirectional sync in TD 2025.32820, comp at
/project1/TableEditor in td-controller-dev.6.toe, 0.1% cook budget).
Vincent's first hands-on drove two RFE rounds, all web-side verified in
mock with clean console: in-TD input parity (double-press editing,
modifier-free gutter select/reorder, column drag-reorder, Apply-sort-
to-DAT, clipboard through ui.clipboard — dblclick/copy/selection
outputs also verified live in-TD over real interactMouse/keyboardin
paths), Lister-style sel_rows/sel_cells DAT outputs, the alt-row
selection-visibility CSS fix, content-aware column widths with a fill
column, and the comp Style page ({t:style} live restyle + themes).
**Pending live TD checks (TD MCP dropped mid-session):** one
`reinitextensions` to apply the Style page + verify a theme switch
renders; Vincent re-test of: double-click edit, gutter drag select/
reorder, column drag, ctrl+c/x/v, sel_rows/sel_cells outputs wired
into a network. Then remaining M2 (1k-row `_rewrite` cost) and **M3**.
This repo has no .toe; rebuild anywhere with td/build_component.py
(exec with encoding='utf-8').

## Design decisions (locked 2026-06-12)

- **Same transport architecture as TD-WEBgui-controller**: webserverDAT
  serves `web/` + WebSocket relay; file-synced td/ Python; webrenderTOP
  in-TD panel; mock mode for no-TD dev; idempotent build_component.py;
  `_ensureSetup()` self-migration on reinitextensions.
- **TD is the source of truth.** The ext snapshots the target table;
  datexec diffs live vs snapshot; the ext's own writes pre-update the
  snapshot so self-echoes are skipped. Clients render optimistically but
  yield to broadcasts.
- **Wire coordinates are DAT coordinates, always.** The grid maps view
  rows → DAT rows before sending ops.
- **View state never mutates the table** (Lister semantics): sort,
  filter, column widths, selection are client-side only. A future
  "apply sort to DAT" is an explicit, separate op (icebox).
- **Structural ops rewrite the DAT** from the edited snapshot
  (clear + appendRow) — version-proof vs uncertain insertRow/deleteRow
  APIs, one datexec fire. Cell edits write `dat[r,c]` directly.
- **Editability rule**: no inputs + not locked = editable; otherwise
  read-only grid with banner (TD's own viewer rule).
- **Row reorder is disabled while sorted/filtered** — reordering a view
  that doesn't match DAT order is undefined; clear sort/filter first.
- **Header row is a comp par** (`Headerrow`), round-trips via
  `{t:setheader}` so all clients agree.
- Column widths persist in localStorage per DAT path; project-portable
  per-table view specs (`specs/<name>.json`) are M5.
- Port 9981 (sibling repo owns 9980).

## Roadmap

### M1 — Core grid (mock mode, no TD required)  ✓ DONE 2026-06-12
- [x] Virtualized grid renders the mock table (header row, row gutter,
      sticky column header, synced scroll; verified to row 60 of the
      61×6 mock and back)
- [x] Selection: click cell, drag range, shift-click extend, row gutter
      selects rows, full keyboard nav (arrows, tab, enter, home/end,
      page up/down, ctrl+arrow to edge, ctrl+a) — ctrl/cmd-click
      multi-range deferred to M4 (single rect selection is the model
      for now)
- [x] Editing: dblclick / Enter / type-to-replace; Esc reverts; Tab/Enter
      commit and advance; Delete/Backspace clears selection
- [x] Clipboard: copy/cut/paste TSV blocks at the anchor cell; paste
      clips to table bounds (grow-on-paste = M3); single value onto a
      selection fills it
- [x] Column resize: drag header edges, widths persist per table path
      (localStorage; verified across reload)
- [x] Sort (header click, 3-state, numeric-aware, stable, numbers before
      strings) + filter (toolbar input) — view-only
- [x] Context menu (in-page DOM): insert/delete rows & cols, clear
      cells; sort items on the header menu; all ops disabled read-only
- [x] Row drag-reorder via the gutter (emits moverows; disabled while
      sorted/filtered)
- [x] Mock bridge applies every op locally (`?mock=1`)
- [x] Verified in a real browser via the preview harness, clean console

### M2 — TD bridge live  ✓ core verified 2026-06-12 (hands-on items remain)
- [x] build_component.py runs clean in TD 2025.32820 (needs
      `encoding='utf-8'` in the exec — TD's open() defaults to ASCII;
      README + CLAUDE.md updated); webserver serves the page (200,
      fresh js); webrender connects as a WS client on its own
- [x] WS round-trip verified live: browser-side `Bridge.send(edit)` →
      DAT cell changed in TD ('WS EDIT OK'), rev incremented, in-TD
      webrender surface showed it (screenshot)
- [x] datexec diff path verified: a Python write to the DAT broadcast a
      delta (rev bump, snapshot updated) and rendered in the page
- [x] Self-echo suppression verified: client edits bump rev exactly once,
      no rebroadcast loop (snapshot pre-update pattern works)
- [x] Editability detection verified live: free table DAT editable;
      evaluateDAT-output target broadcast `editable:false` with rows
      still visible. **Fixed: the python attr is `OP.lock` — `.locked`
      doesn't exist on tableDAT** (AttributeError made everything
      read-only)
- [x] Structural ops verified live over the real WS (insertrows landed
      exact values; delete/move share the same `_rewrite` path,
      mock-verified)
- [ ] `_rewrite` cost on a ~1k-row table (defer: the dev session was
      already fps-starved; measure in a quiet session)
- [ ] In-TD input hands-on: mouse forwarding (click/drag/wheel/
      right-click) and keyboardin typing into cell editors — needs
      Vincent at the machine
- [x] Openviewer window verified (winopen/winclose pulses, `.isOpen`
      round trip)
- [x] Perf: comp holds 0.1% cook budget / 0.12ms cpu/s with a client
      connected (the dev project's global fps dips are MCP overhead +
      pre-existing project load, not the comp)

### M3 — Structure & clipboard power
- [ ] Paste grows the table when the block exceeds bounds (insertrows/
      insertcols then edit, one undo-able burst)
- [ ] Fill-down (ctrl+d) / fill-right (ctrl+r); drag-fill handle on the
      selection (copy fill; smart series = icebox)
- [ ] Multi-row/col insert (insert N at selection), duplicate rows
- [ ] Column drag-reorder (header drag, writes the DAT)
- [ ] Undo/redo: wire grid ops into TD's undo system if viable
      (ops via `run` with undo blocks), else ext-side undo stack
- [ ] Bigger-paste stress test (10k cells)

### M4 — Lister-parity view tools
- [ ] Multi-column sort (shift-click adds a sort key)
- [ ] Per-column filters + filter row mode; regex/exact/numeric operators
- [ ] Column type hints (numeric/string/color) for sort + alignment;
      color cells render swatches (Lister's color sourceDataMode)
- [ ] Frozen columns (pin left N cols)
- [ ] Find & replace across the table (with selection scope)
- [ ] Row striping / divider options; compact density toggle
- [ ] "Apply view to DAT" explicit op: writes the current sort order into
      the table (with confirm)

### M5 — Workflow & persistence
- [ ] ctrl.t workflow documented + helper: `ext.Open(path)` retargets and
      pops window; example keyboardin macro snippet for Vincent's setup
- [ ] Follow-selection mode: editor retargets to the currently selected
      DAT in the network editor (poll `ui.panes` selection)
- [ ] Per-table view specs in `specs/<opName>.json` (column widths, type
      hints, frozen cols, header flag) — project-portable, hot-reload,
      localStorage stays the fallback
- [ ] Multi-table tabs: recent targets as tabs along the top
- [ ] Theme/style pars on the comp (reuse the sibling's Style page
      pattern) → CSS vars

### Later / icebox
- Apply-filter-to-DAT (destructive filter with confirm); smart series
  drag-fill; CSV import/export buttons; per-cell expression evaluation
  preview (show `eval()` like Lister's eval mode); topPath-style cell
  graphics; multi-client cursors/presence; CHOP/SOP table views
  (read-only); OSC/MIDI row triggers (cue-list mode).

## Changelog

### 2026-06-12 — Session 1k (in-TD modifiers: shift/ctrl/cmd clicks, shift+wheel, drmbt menu)
- Vincent reported the 1h/1i features dead in-TD (fine in browser):
  shift/cmd/ctrl clicks, shift+wheel, no drmbt theme. Root causes:
  (1) `_ensureSetup` set Theme menuNames only at par creation — his
  Theme par predates drmbt, menu never refreshed; now menu items sync
  on every init. (2) `ForwardWheel` read the panel CHOP `shift`
  channel, which does NOT track bare key presses (focus-gated); his
  shift presses were landing in the keyboardin log instead — verified
  empirically from the key-log rows (`lshift`/`cmd`/`lcmd`, both
  states, plus a `cmd` column on every event). (3) ctrl/cmd/shift
  click selection only ever existed browser-side; interactMouse
  carries no modifier flags.
- Fix: the ext now tracks `_mods` {shift,ctrl,alt,cmd} from keyboardin
  (modifier keys arrive as their own key events, both keydown and
  keyup; `_KB_TEXT` routes them to `OnModifierKey`), resyncs from the
  chord flags on every regular keypress (`SyncMods` — recovers keyups
  missed while unfocused), folds in any panel modifier channel
  transitions, and pushes changes to the page as `window.__tdMods`.
  `ForwardWheel` horizontal-scrolls on tracked OR channel shift. The
  grid merges `__tdMods` with the event's own flags (`evMods`) at the
  body and gutter pointerdown handlers — browser behavior unchanged
  (falls back to event flags).
- Live-verified through the real keyboardin callback (fabricated
  keyInfo namedtuples into `keyboardin1_callbacks.module.onKey`):
  lshift down → `__tdMods.shift` true in page → wheel with the panel
  channel reporting False still scrolled horizontally (0→104);
  cmd-click on two non-contiguous cells → 2 selected, mirrored out
  sel_rows; plain keypress cleared the stuck cmd (chord resync);
  shift-click extended to a 3×2 rect. Theme menu now lists drmbt;
  applied live (red accent + warm highlight screenshot), then
  Vincent's dark theme restored exactly from a par snapshot.

### 2026-06-12 — Session 1j (live verification of 1i + F2 in-TD fix)
- **MCP back, full live pass over the real comp** (td-controller-dev.9,
  target `/project1/define`): Reloadclients picked up the 1i js (page
  reports `__tdKey`/`__tdHWheel` live via a `{t:clip}` readback — note
  `Bridge` is a top-level `const`, NOT on `window`). In-TD cell edit
  cycle through real pointer events + `__tdKey` (select → Enter →
  type → Enter) hit the DAT; ctrl+z/ctrl+y round-tripped it exactly.
  Structural undo verified live: toolbar +Row 13→14, ctrl+z restored
  13 via `{t:replace}` → ext `_rewrite`, data intact. `__tdHWheel(-2)`
  scrolled body.scrollLeft 0→105 (clamped) and back; live
  chopexec_mouse text == `_CE_TEXT`, panel select string carries
  shift/ctrl/alt. Rowheight 28→40 applied live over `{t:style}` (no
  reload), screenshot also confirmed selection highlight + gutter
  tint + `r2 c0` status in-TD. All test edits undone; comp pars
  restored. (The 250 "File not found for sync" warnings in this .toe
  are ListerUI modules from the sibling repo, not ours.)
- **F2 fix**: `f2` was missing from `TD_KEYS`, so F2 never started
  editing through the in-TD keyboardin path (len-2 key names fall
  through to null; external browsers were fine). Added `f2:'F2'`;
  verified live — F2 opens the editor on the selected cell in-TD,
  Enter commits, ctrl+z restores. keyboardin1 `keys` par is empty
  (all keys forwarded), so no TD-side change needed.

### 2026-06-12 — Session 1i (RFE: undo, no type-to-edit, selection-follow, shift+wheel)
- **TD state verified without MCP** (still not re-registered with this
  session): the live :9981 table broadcast carries the `highlight`
  style key and Vincent's rowh=28 tweak → the 1h ext IS loaded, Style
  page + Reloadclients exist. A setheader round trip over the WS proved
  the parexec valuechange path fires and rebroadcasts within a frame —
  so theme changes DO broadcast; his in-TD page just runs pre-1e js.
  **One Reloadclients pulse fixes it for good.**
- **Typing regression fixed**: type-to-replace removed — editing starts
  only via double-click/Enter/F2, so typing aimed at the filter can
  never overwrite cells. In-TD `__tdKey` now routes keys to whatever
  page input has focus (filter box: chars/backspace/esc/enter handled,
  input events fired) before falling through to grid nav.
- **Undo/redo**: client-side history (cap 100). Cell edits (incl.
  paste/clear/cut) store inverse value lists; structural ops
  (insert/delete/move rows & cols, sort-apply, toolbar adds) snapshot
  the table pre-op and restore via the new `{t:replace}` op (ext
  `_replaceCells` → `_rewrite`). ctrl+z / ctrl+shift+z / ctrl+y, also
  through the in-TD keyboardin path. Single-editor assumption
  documented. Toolbar +Row/+Col routed through Grid.appendRow/Col for
  undo coverage.
- **Selection follows reorder**: after a gutter drag-reorder the moved
  block stays selected at its drop position (verified: cues 2,3 moved
  to view rows 4,5, selection followed).
- **Shift+wheel horizontal scroll**: Vincent exposed the panel `shift`
  channel; chopexec ignores modifier-channel changes, reads shift at
  wheel time → `ForwardWheel(..., shift)` → `__tdHWheel` scrolls
  body.scrollLeft (interactMouse wheel is vertical-only). External
  browsers already do shift+wheel natively. Panel select string now
  canonical with `shift ctrl alt` (ensureSetup + builder).
- **Drag-listener leak hardening**: all drag move/up handlers now attach
  to `window` (a pointerup that escapes a failed pointer capture could
  leave a live select-mode handler hijacking later drags — caught when
  a leaked handler turned a 2-row reorder into a 6-row selection in
  tests); shift-click on the gutter no longer arms a drag.
- All verified in mock, clean console: no-edit-on-type, undo/redo cycles
  (cell + structural + via __tdKey), filter typing via __tdKey with esc
  clear, __tdHWheel 0→240→0, selection-follow.
- Row-index click already selects the row and highlights the index
  (gutter `.sel` styling) — Vincent's report was the stale-page issue.

### 2026-06-12 — Session 1h (RFE: drmbt theme, highlight color, hover, multi-select, reload pulse)
- **Theme-needs-refresh diagnosis**: the in-TD page is almost certainly
  running stale js — the `{t:style}` handler shipped in session 1e, but
  the queued page reload was cut off when the MCP dropped, so style
  broadcasts arrive and are ignored until one refresh. Added the
  recovery: **Reloadclients pulse** → `{t:reload}` WS broadcast (+
  executeJavaScript belt for a wedged webrender) → every client
  reloads. After Vincent's next reload, theme switches should apply
  live; if not, re-investigate the parexec with MCP.
- **Highlight color**: new Highlightcolor Style par → `--hl`; selection,
  cursor and hover tints now derive from it via color-mix (accent and
  highlight restyle independently). All themes gained the key.
- **drmbt theme**: off-white text (#f2efe8) on near-black (#111112) with
  charcoal cells, accent RGB(1,.3,.3) #ff4d4d, desaturated-yellow
  highlight #c7b573. Verified visually in mock via the new
  `window.__applyStyle` debug hook (screenshot: red-orange accent,
  yellow selection tint).
- **Hover highlight** on cells and gutter (`--hover-bg` from --hl);
  in-TD gets it via the existing forwarded hover moves.
- **Multi-select**: selection is now an active rect + extra rects.
  Ctrl/cmd-click adds areas; gutter ctrl/cmd-click toggles rows in a
  non-contiguous row set (contiguous runs merge); plain click/ctrl+a/
  Esc collapse; clear (Delete) spans all areas; copy of multiple
  full-width row rects emits the row union as TSV in view order
  (Lister "copy picked rows"); sel payload rows = union of DAT
  indices, so sel_rows mirrors every picked row. In-TD note: mouse
  forwarding has no modifiers — gutter drag remains the in-TD path.
  Verified in mock: 2-area cell select, 3-row toggle set, toggle-off,
  TSV union (cues 2,7), payload [2,7], multi-area clear, regressions
  (shift-extend, double-press edit) all green, clean console.
- sel outputs + Reloadclients added to build_component for parity.
- TD MCP unavailable all session — TD-side bits (Reloadclients par
  creation, Highlightcolor par, drmbt preset, theme-switch live
  restyle) need one reinitextensions + hands-on check next session.

### 2026-06-12 — Session 1f (verification pass: wire correctness under view state)
- TD MCP offline; ran the offline checks. Syntax: py_compile clean on
  td/*, node --check clean on web/js/*.
- Wire-correctness battery in mock with a Bridge.send spy, all passed:
  edit while filtered+sorted targets the right DAT row (vr0 → r26);
  block paste under sort maps per view row (AAA→r26, BBB→r20);
  `{t:sel}` payload carries non-contiguous DAT indices under sort
  ([26,20,46], c0/c1 span); cut copies the selected value and sends the
  clear-edit to the selected DAT row (isolated test exact; an earlier
  in-battery anomaly was test sequencing — sort still active between
  evals — not a grid bug); saved column width (200px) survives a table
  reload while other columns stay auto and the fill still covers the
  viewport; header-row-off view includes DAT row 0. Zero console
  errors.
- Note for the next TD session: everything TD-side since commit ced8cbe
  is unverified live (style page, sel outputs creation already verified
  except the Style page; one loadonstartpulse + reinitextensions
  applies it all).

### 2026-06-12 — Session 1g (live verification without MCP, via the comp's own WS)
- TD MCP stayed disconnected, but the comp's webserver on :9981 is a
  direct line: drove the LIVE page in the preview browser against the
  real TD. The table broadcast carries a fully populated style dict
  (all ten colors + fontsize + rowh read from live par values) —
  **proves the Style page exists on the comp and the new ext is
  loaded** (the pre-disconnect reinit did land).
- Live page against Vincent's real colDefineOptions (16×6, editable,
  conn ok): content-aware widths fit short columns (134/102/102/102/
  110) and the content-richest Delete column absorbed 678px to exactly
  fill the 1228px viewport.
- Still pending live (needs a TD-side par touch — Vincent or MCP):
  Theme menu switch → {t:style} live restyle of connected clients.

### 2026-06-12 — Session 1e (RFE: style page, smart column widths, selection visibility)
- **Selection visibility bug** (Vincent's report): `.vrow.alt .cell`
  (specificity 0,3,0) outranked `.cell.sel` (0,2,0), so selected cells
  on alternate striped rows showed no feedback at all. Selection/cursor
  rules now carry `.vrow.alt`-level specificity; verified computed
  backgrounds differ on alt rows. `--accent-soft`/`--cur-bg` now derive
  from `--accent` via color-mix so one Style par recolors selection.
- **Content-aware column widths**: columns auto-fit their content
  (sample ≤500 rows, char-count × font-derived px, clamp 40–420);
  the content-richest column is the fill column and absorbs leftover
  viewport width (effective widths = persisted base + fill stretch, so
  stored widths never bloat). Manual resizes edit the base and persist;
  window resize re-stretches. Verified in mock: 6 cols → 46/118/86/78/
  46/843 summing exactly to the 1217px body.
- **Style page** (sibling pattern): ten RGB color pars + Fontfamily/
  Fontsize/Rowheight + Theme menu (custom/dark/light/synthwave) created
  idempotently by `_ensureSetup`; `{t:style}` broadcasts (coalesced via
  run-delay) + style dict on every table msg; page maps them to CSS
  vars; `Grid.setStyle` keeps the virtualization ROWH in sync with
  `--rowh` (verified: row tops re-laid at 34px). **Live TD verification
  pending** — TD MCP dropped mid-reinit; the code is file-synced, one
  `reinitextensions` applies it (Style page self-creates).
- Preview harness note: the Xcode python3 shim now fails with
  PermissionError under preview_start; launch.json points at
  /opt/homebrew/bin/python3 (this session served via a Bash background
  http.server on :8127).

### 2026-06-12 — Session 1d (RFE round: in-TD input parity + selection outputs)
- Vincent's hands-on: scroll + keyboard ✓; double-click, row
  multi-select, copy — ✗ in-TD. Root causes: interactMouse never
  synthesizes dblclick; forwarded mouse carries no modifier keys;
  offscreen CEF has no OS clipboard.
- **Double-press detection in the page** (two pointerdowns on the same
  cell <400ms) replaces reliance on native dblclick — verified live
  in-TD via two rapid interactMouse clicks: editor opened with text
  select-all highlighted on Vincent's colDefineOptions table (edit
  Esc'd, table untouched).
- **Modifier-free gutter**: drag on an unselected row range-selects;
  drag on a selected row reorders (dropline); shift-click still extends
  in external browsers. Verified in mock (range 4×6; block of 4 rows
  moved to top).
- **Column drag-reorder** on the header (writes the DAT via movecols;
  widths follow their columns); plain click still cycles sort.
  **Apply sort to DAT** in the header context menu sends `{t:reorder}`
  (full data-row permutation; header pinned; ext rewrites). Both
  verified in mock.
- **In-TD clipboard through TD**: keyboardin forwards ctrl/cmd;
  ForwardKey intercepts ctrl+c/x/v → `__tdCopy`/`__tdPaste` →
  `{t:clip}` → `ui.clipboard`. Verified live: ctrl+c put the selected
  cell's TSV into ui.clipboard ('columnLabel').
- **Selection outputs**: `{t:sel}` (debounced 150ms) → ext mirrors into
  sel_rows/sel_cells tableDATs wired to outDATs (comp gains DAT out
  connectors; created idempotently by _ensureSetup, cleared on
  retarget). Verified live through a real forwarded interactMouse
  click: sel_rows filled with the clicked row of Vincent's lister
  config table.
- Protocol additions documented in README: reorder / sel / clip.

### 2026-06-12 — Session 1c (M2 core: live bidirectional sync in TD)
- TD MCP recovered mid-session; built /project1/TableEditor in
  td-controller-dev.6.toe via build_component.py. First run hit
  UnicodeDecodeError — TD's open() defaults to ASCII; exec with
  `encoding='utf-8'` (README + CLAUDE.md updated).
- **Bug fixed live**: `_editable` checked `dat.locked`, which doesn't
  exist on tableDAT → AttributeError → everything read-only. The real
  attr is `OP.lock`. Also recorded windowCOMP `.isOpen` (pulse pars
  read False).
- Verified live: webserver 200 + fresh js; webrender self-connected as
  a WS client and survived reinitextensions (seeded clients); web→TD
  edit landed in the DAT and rendered in-TD (screenshot); TD-side
  Python write → diff → delta broadcast (rev bump, snapshot updated);
  WS insertrows grew the demo table with exact values; evaluateDAT
  target broadcast editable:false with rows visible; window
  open/close round trip; comp at 0.1% budget / 0.12ms cpu/s.
- Test edits cleaned up (demo_table restored, ro_test destroyed,
  window closed). The host project's fps dips during the session were
  MCP call overhead + pre-existing project load (448 pre-existing
  warnings incl. uberGUI sync paths — not ours).

### 2026-06-12 — Session 1b (M1 done: core grid verified in-browser)
- Full M1 test battery in the preview harness against `?mock=1`:
  selection (cell/range/row-gutter, header offset mapping view→DAT
  confirmed: vr2 = DAT r3), editing (dblclick/Enter/type-to-replace/
  Esc/commit-advance), keyboard nav incl. shift-extend and clear,
  TSV copy/paste (block paste + single-value fill verified through
  synthetic ClipboardEvents), numeric-aware 3-state sort, live filter
  (61×6 → "16 shown"), context-menu insert/delete rows & cols, gutter
  drag-reorder (dropline + moverows through the mock), column resize
  with localStorage persistence across reload, header-row toggle
  round-trip, read-only mode (editor blocked, every ctx op disabled),
  virtual scroll to the bottom row. Zero console errors throughout.
- Bugs found and fixed: (1) `#emptystate`'s `display:flex` overrode the
  `hidden` attribute — overlay stayed up over live tables; added a
  `[hidden]` rule. (2) The document-level context-menu closer ran on
  the same bubbling pointerdown that opened the menu, closing it in
  the same tick — moved the closer to the capture phase. (3) Wrapped
  `setPointerCapture` in a try (inactive pointer ids throw and would
  kill the drag handlers mid-gesture).
- Preview-harness gotcha re-confirmed from the sibling repo: the
  viewport can report 0×0 (rAF also throttles when hidden) until an
  explicit `preview_resize` — body.clientHeight 0 faked "missing rows"
  during sort/filter tests; the view logic was correct all along.

### 2026-06-12 — Session 1 (research + scaffold)
- Researched the architecture donor (TD-WEBgui-controller CLAUDE.md /
  SPRINTBOARD.md / ext / bridge / builder) and the Lister palette docs;
  pulled the sibling's verified TD gotchas into CLAUDE.md (same
  transport, same traps). Live TD instance (td-controller-dev.6.toe) was
  unreachable over MCP (timeouts) — ListerUI in-session inspection and
  all live verification deferred to the next TD session (M2).
- Locked design decisions: DAT coords on the wire, snapshot/diff sync
  with pre-updated-snapshot echo suppression, view state client-side
  only, structural ops via rewrite, editability = no inputs + unlocked,
  port 9981.
- Scaffolded: CLAUDE.md, README.md (protocol documented), this
  sprintboard, .gitignore, .claude/launch.json (web-mock :8125),
  td/TableEditorExt.py, td/webserver_callbacks.py, td/build_component.py
  (comp + demo cue-sheet table), web/ (index.html, css/theme.css,
  js/bridge.js with mock table + full op handling, js/grid.js
  virtualized grid, js/main.js wiring).
