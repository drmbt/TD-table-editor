# TD-table-editor

A modern table editor for TouchDesigner DAT tables, rendered in a browser.
Point the `TableEditor` comp at any table DAT and edit it in a
spreadsheet-style grid — in-TD via a `webrenderTOP` panel, or in any
external browser on the network — with **bi-directional sync**: edits in
the grid write the DAT, and any change to the DAT (scripts, cooking,
other clients) streams back into every connected grid.

## Why

TD's built-in DAT viewer leaves much to be desired as an editor: no
multi-cell selection, no copy/paste blocks, no column resizing, no
sorting or filtering, no row reordering. The palette
[Lister](https://docs.derivative.ca/Palette:lister) gets much closer —
snappy list UI, sorting, filtering, drag-reorder — but it's a native
panel COMP that costs main-thread cook time, and configuring it per-table
is real work.

This project takes the architecture proven by
[TD-WEBgui-controller](https://github.com/drmbt/TD-WEBgui-controller)
(itself a successor to EnviralDesign's UberGui) and applies it to tables:

- **Render the UI in a browser engine.** Chromium is extremely good at
  drawing grids. TD's job shrinks to relaying table data over a
  WebSocket — ~0.0% cook budget at idle.
- **Gesture logic lives in the page.** Selection models, keyboard
  navigation, drag-reorder, clipboard handling — plain JavaScript,
  debuggable in desktop Chrome devtools.
- **TD stays the source of truth.** The ext snapshots the target table
  and diffs on every table change; every write echoes to every client.
- **View state never mutates the table.** Sorting, filtering and column
  widths are per-client view state — exactly Lister's semantics: filters
  affect what you see, not what's stored.
- **No framework, no build step.** `web/` is dependency-free HTML/CSS/JS,
  servable as-is by the `webserverDAT`. Open `web/index.html?mock=1` in
  any browser to develop with zero setup.

## Features

- Spreadsheet-style grid with **virtualized scrolling** (large tables stay
  snappy)
- **Cell editing**: double-click, Enter or F2 (deliberately *not*
  type-to-replace — stray typing never overwrites cells); Esc reverts;
  Tab/Enter commit and advance
- **Undo / redo** (ctrl+z / ctrl+shift+z / ctrl+y) covering cell edits,
  paste, clear, and structural ops (insert/delete/move/sort-apply
  restore from snapshots)
- **Multi-cell selection**: click-drag ranges, shift-click extend,
  **ctrl/cmd-click adds non-contiguous areas** (and toggles rows on the
  gutter — copy your picked rows as TSV), full keyboard navigation
- **Copy / cut / paste** TSV blocks — interoperable with Excel, Sheets,
  and text editors
- **Row reordering** by dragging the row gutter (writes the DAT; the
  selection follows the dropped block); dragging an unselected row
  **range-selects** rows instead — no modifier keys needed, so it works
  with in-TD forwarded mouse input. Shift+wheel scrolls horizontally
- **Column reordering** by dragging a column header (writes the DAT);
  a plain click still sorts
- **Insert / delete rows and columns** via context menu and toolbar
- **Sorting** (click a column header, 3-state) and **filtering** (live
  text filter) — view-only by default; **Apply sort to DAT** (header
  right-click) writes the sorted order back into the table
- **Selection outputs**: the comp has two DAT out connectors mirroring
  the live selection — `out1` the full selected rows, `out2` the selected
  cell block — so the editor doubles as a Lister-style picker you can
  wire into your network
- **In-TD clipboard**: ctrl+c/x/v in the TD panel route through
  `ui.clipboard` (offscreen CEF has no OS clipboard); external browsers
  use the native clipboard
- **Content-aware column sizing**: columns auto-fit their content — short
  columns stay narrow, long-text columns get more room (capped), and the
  content-richest column stretches to fill the panel so no space is
  wasted. Manual drag-resizes persist per table and override auto widths
- **Style page** on the comp: eleven theme colors (incl. a dedicated
  **Highlight** color for selection/hover tints, independent of the
  accent), font family/size and row height restyle every connected
  client live (dark / drmbt / light / synthwave presets via the Theme
  menu, tweakable from there). A **Reload Web Clients** pulse force-
  refreshes every connected page (stale-js recovery)
- **Header row** mode: first DAT row becomes the sticky column header
- Read-only mode with banner for non-editable DATs (cooked outputs,
  locked) — same rule as TD's own viewer
- Works as an in-TD popup panel (the ListerUI ctrl.t workflow: call
  `ext.Open(datPath)` from a keyboard macro) and simultaneously in any
  external browser

## Architecture

```
┌─ TouchDesigner ──────────────────────────────┐
│  TableEditor (containerCOMP)                 │
│   ├ TableEditorExt   ... snapshot/diff/sync  │
│   ├ webserver1 (webserverDAT)                │
│   │    serves ./web/* over HTTP              │
│   │    WebSocket ⇅ {edit/delta/table}        │
│   ├ datexec_target   ... watches the target  │
│   │    table DAT for changes                 │
│   ├ webrender1 (webrenderTOP)                │
│   ├ window1 (windowCOMP) ... popup viewer    │
│   └ panel CHOP + keyboardin → input forward  │
└──────────────────────────────────────────────┘
        ▲ http/ws                  ▲ http/ws
   webrenderTOP                external browser
   (in-TD popup editor)        (second screen, devtools)
```

- **TD → web:** `datexec_target` fires on any table change; the ext diffs
  the live table against its snapshot — same-shape changes broadcast as
  cell deltas, shape changes as a full snapshot. The ext's own writes
  update the snapshot first, so they don't re-broadcast as echoes.
- **Web → TD:** the grid sends edit ops over the WebSocket; the ext
  writes the DAT (cell writes via `dat[r,c]`, structural ops by
  rewriting from the edited snapshot) and broadcasts the result to every
  client.

## WebSocket protocol

Client → TD:

```jsonc
{"t":"hello"}                              // request full table
{"t":"edit", "edits":[{"r":1,"c":2,"v":"text"}]}  // cell writes
{"t":"insertrows", "at":3, "rows":[["a","b"],[]]} // [] = blank row
{"t":"deleterows", "rows":[4,5,9]}
{"t":"moverows",   "rows":[4,5], "to":1}   // to: pre-removal DAT index
{"t":"insertcols", "at":2, "count":1}
{"t":"deletecols", "cols":[3]}
{"t":"movecols",   "cols":[2], "to":0}
{"t":"reorder",    "rows":[5,3,4]}         // full data-row permutation:
                                           // "Apply sort to DAT" writes the
                                           // view's order into the table
{"t":"replace", "cells":[["a","b"],["c","d"]]}  // whole-table rewrite (the
                                           // client undo path for structural
                                           // ops, and grow-on-paste)
{"t":"sel",  "sel":{"rows":[2,3], "c0":0, "c1":4}}  // selection (debounced);
                                           // mirrored into the comp's
                                           // sel_rows / sel_cells outputs
{"t":"clip", "text":"a\tb"}                // in-TD copy: ext sets ui.clipboard
{"t":"getclip"}                            // clipboard pull: ext replies with
                                           // a {t:"clip"} carrying ui.clipboard
                                           // (gutter "Insert clipboard rows")
{"t":"setheader",  "on":true}              // first row = sticky header
{"t":"settable",   "path":"/project1/table1"}  // retarget the editor
```

TD → client:

```jsonc
{"t":"table", "rev":7, "path":"/project1/table1", "name":"table1",
 "editable":true, "headerRow":true, "style":{"bg":"#16181c", "rowh":26},
 "cells":[["name","dur"],["intro","30"]]}
{"t":"delta", "rev":8, "edits":[{"r":1,"c":1,"v":"45"}]}
{"t":"style", "style":{"accent":"#b45fff", "fontsize":13}}  // live restyle
{"t":"clip", "text":"a\tb"}                // reply to {t:"getclip"}
{"t":"reload"}                             // Reloadclients pulse: pages reload
{"t":"error", "msg":"..."}
```

All `r`/`c` are **DAT coordinates** (header row included). Sorting and
filtering happen client-side; the grid maps view rows to DAT rows before
sending any op. `rev` is monotonic; a full `table` resets the baseline.

## Install / run

1. Clone the repo. Open `td/build_component.py`, set `REPO` if the repo
   lives somewhere other than `~/Documents/github/TD-table-editor`, and
   run it in TD's textport:

   ```python
   exec(open('/path/to/td/build_component.py', encoding='utf-8').read())
   ```

   (the explicit `encoding` matters — TD's `open()` defaults to ASCII and
   the script contains UTF-8.)

   It builds `/project1/TableEditor` idempotently (safe to re-run).
2. Set the comp's `Targetop` to any table DAT. The comp's panel (and
   `http://127.0.0.1:9981/` in any browser) shows the editor.
3. `Openviewer` pulses the popup window; `Openinbrowser` opens the
   external browser. For a ctrl.t-style workflow, have a keyboard macro
   call `op('/project1/TableEditor').Open(selectedDat.path)`.

All TD-side Python is file-synced from `td/` — edit the repo files and TD
picks them up.

## Testing

- **Without TD:** open `web/index.html?mock=1` in any browser — a built-in
  demo table and loopback bridge make every grid feature testable offline.
- **With TD:** `curl http://127.0.0.1:9981/` should return the page. Edit
  a cell in the browser and watch the DAT; write the DAT from a script
  and watch the grid.

## Roadmap

See [SPRINTBOARD.md](SPRINTBOARD.md) for the full roadmap and changelog.

## Credits

- Derivative's [Lister](https://docs.derivative.ca/Palette:lister) — the
  feature benchmark for what a TD table UI should do.
- [TD-WEBgui-controller](https://github.com/drmbt/TD-WEBgui-controller) —
  the transport architecture this project reuses.
- Built by [Vincent Naples (drmbt)](https://github.com/drmbt) with Claude
  Code.
