# SPRINTBOARD

Roadmap = the to-do list. Check items off as they land, append to the
changelog each session, and keep design decisions current. Next sprint is
always the top unchecked milestone. Update after tests and RFEs, and
always before pushes.

## Status — 2026-06-12

Session 1: repo scaffolded from the TD-WEBgui-controller architecture.
Web grid, bridge with mock mode, TD extension, webserver callbacks and
idempotent builder written; nothing live-verified in TD yet (the running
TD instance was unreachable over MCP during scaffolding — verify M2 items
live in the next TD session). Lister feature set researched
(docs.derivative.ca/Palette:lister) as the parity benchmark.

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

### M1 — Core grid (mock mode, no TD required)  ← NEXT
- [ ] Virtualized grid renders the mock table (header row, row gutter,
      sticky column header, synced scroll)
- [ ] Selection: click cell, drag range, shift-click extend, ctrl/cmd
      toggle, row gutter selects rows, full keyboard nav (arrows, tab,
      enter, home/end, page up/down, ctrl+arrow to edge, ctrl+a)
- [ ] Editing: dblclick / Enter / type-to-replace; Esc reverts; Tab/Enter
      commit and advance; Delete/Backspace clears selection
- [ ] Clipboard: copy/cut/paste TSV blocks at the anchor cell; paste
      clips to table bounds (grow-on-paste = M3)
- [ ] Column resize: drag header edges, widths persist per table path
      (localStorage)
- [ ] Sort (header click, 3-state, numeric-aware) + filter (toolbar
      input) — view-only
- [ ] Context menu (in-page DOM, offscreen CEF has no native menus):
      insert/delete rows & cols, clear cells
- [ ] Row drag-reorder via the gutter (emits moverows; disabled while
      sorted/filtered)
- [ ] Mock bridge applies every op locally so all of the above is
      testable in `?mock=1`
- [ ] Verified in a real browser via the preview harness, clean console

### M2 — TD bridge live
- [ ] build_component.py runs clean in TD 2025.x; webserver serves the
      page; WS round-trip verified (edit a cell → DAT changes → second
      client updates)
- [ ] datexec diff path verified: script-driven DAT writes appear in the
      grid as deltas; shape changes rebroadcast full table
- [ ] Self-echo suppression verified (no rebroadcast loop on client edits)
- [ ] Editability detection verified on: free table DAT, locked DAT,
      DAT with inputs (evaluate/select/merge outputs)
- [ ] Structural ops verified live (insert/delete/move rows & cols);
      confirm `_rewrite` cost is acceptable on a ~1k-row table, else
      switch to native insert/delete APIs (verify they exist in 2025.x)
- [ ] In-TD input: mouse forwarding (click/drag/wheel/right-click) and
      keyboardin typing into cell editors
- [ ] Openviewer window pops the panel (windowCOMP pars verified live)
- [ ] Perf: ~0.0% cook budget idle, acceptable during edit bursts

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
