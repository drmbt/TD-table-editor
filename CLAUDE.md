# CLAUDE.md — TD-table-editor

A replacement for TouchDesigner's built-in DAT table viewer/editor: point the
TableEditor comp at any table DAT and get a modern spreadsheet-style editor
rendered in Chromium (webrenderTOP in-TD, or any external browser), with
bi-directional sync over a webserverDAT WebSocket. Sibling project to
TD-WEBgui-controller (same repo layout, same transport architecture, same
philosophy: rendering and gesture logic live in the page, TD's main thread
only relays data).

**Read SPRINTBOARD.md after this file, before starting work** — it holds the
roadmap, locked design decisions, and the changelog. Update it after tests
and RFEs, and always before pushes: check off / add tasks, append a
changelog entry.

## Architecture

```
target table DAT (anywhere in the project)   ←  TD is the source of truth
        ▲ writes (setCell / rewrite)   │ datexec_target watches onTableChange
        │                              ▼
TableEditorExt (td/TableEditorExt.py)
  - caches a snapshot of the table; OnTableChange diffs live vs snapshot
    (snapshot already updated for our own writes → self-echo is skipped)
  - same-shape change → {t:delta, edits:[{r,c,v}]}; shape change → full
    {t:table} snapshot. Structural client ops rewrite the DAT from the
    edited snapshot (clear + appendRow) and broadcast a full table.
        ▲ ws://127.0.0.1:9981
webserverDAT (td/webserver_callbacks.py serves web/* from disk + WS relay)
        ▲ http
web/ (index.html, js/bridge.js, js/grid.js, js/main.js, css/theme.css)
  - grid owns ALL view state: sort, filter, column widths, selection —
    never sent to TD, never mutates the table (Lister semantics)
  - wire coordinates are always DAT coordinates (the grid maps view→DAT)
        ▲ rendered by
webrenderTOP in /project1/TableEditor (+ panel CHOP → interactMouse
forwarding, keyboardin → ForwardKey; window1 pops the panel up — the
ctrl.t ListerUI-style workflow calls ext.Open(datPath))
```

WS protocol — client→TD: `{t:hello}` `{t:edit,edits:[{r,c,v}]}`
`{t:insertrows,at,rows:[[...]]}` `{t:deleterows,rows:[...]}`
`{t:moverows,rows:[...],to}` `{t:insertcols,at,count}`
`{t:deletecols,cols:[...]}` `{t:movecols,cols:[...],to}`
`{t:reorder,rows:[perm]}` (Apply sort to DAT) `{t:replace,cells:[[...]]}`
(whole-table rewrite — the client undo path for structural ops)
`{t:sel,sel:{rows,c0,c1}}` (→ sel_rows/sel_cells output DATs)
`{t:clip,text}` (→ ui.clipboard)
`{t:setheader,on}` `{t:settable,path}`;
TD→client: `{t:table,rev,path,name,editable,headerRow,style,cells:[[...]]}`
`{t:delta,rev,edits:[{r,c,v}]}` `{t:style,style}` `{t:reload}`
(Reloadclients pulse — stale-page recovery) `{t:error,msg}`.
Style dict (comp Style page → CSS vars): bg panel cell cellalt grid
header gutter text textdim accent highlight font fontsize rowh —
selection/hover tints derive from `highlight` (--hl), not accent.
Themes: custom/dark/drmbt/light/synthwave (the ext re-syncs the Theme
par's menu items on every init — themes added later must land on
existing comps). Selection model: one ACTIVE rect + extra rects
(ctrl/cmd-click adds areas; gutter ctrl-click toggles rows; gutter
drag range-selects/reorders modifier-free). interactMouse carries no
modifier flags, so the ext tracks modifier state from keyboardin
(modifier keys arrive as their own key events, BOTH states; chord
flags on regular keys resync missed keyups) and pushes it to the page
as `window.__tdMods`; the grid merges that with the event's own flags
(`evMods`) at every pointerdown — in-TD shift/ctrl/cmd clicks behave
like a browser's. Editing starts ONLY via double-click/Enter/F2 —
no type-to-replace (stray typing must never overwrite cells); `__tdKey`
routes to whatever page input has focus (filter box) before grid nav.
Undo/redo: ctrl+z / ctrl+shift+z / ctrl+y — client-side history; cell
edits store inverse values, structural ops snapshot the table and
restore via {t:replace} (single-editor assumption). Reorder keeps the
selection on the moved block. Shift+wheel scrolls horizontally in-TD
(`__tdHWheel`; shift comes from the tracked `_mods` OR the panel
`shift` channel — the panel channel alone is focus-gated and misses
bare key presses; interactMouse wheel is vertical-only). In-TD ctrl+c/x/v
route through ui.clipboard (ForwardKey intercepts); column widths are
content-aware with a fill column (the content-richest column absorbs
spare viewport width); saved manual widths override auto.
All r/c are DAT coordinates. `rev` is monotonic per ext instance; a full
`table` resets the client baseline. `moverows.to` is an insertion index in
pre-removal DAT coordinates (the ext adjusts for rows removed above it).
Document any protocol change in README.md.

Editability: a DAT is editable when it has no inputs and isn't locked
(`_editable()`); otherwise the grid renders read-only with a banner —
same as TD's own viewer on a cooked DAT. TD is final authority: every
write path re-checks.

## The live TD relationship

- All TD-side Python lives in this repo; DATs in the comp are file-synced
  (`par.file` + `syncfile=True`). Edit the repo file → TD picks it up.
  After editing the extension: `loadonstartpulse.pulse()` on the DAT, then
  `comp.par.reinitextensions.pulse()`.
- `td/build_component.py` is the idempotent installer (destroys + rebuilds
  `/project1/TableEditor`). Keep it in sync with any structural change.
- `ext._ensureSetup()` is the canonical owner of parexec_self /
  datexec_target / chopexec_mouse / keyboardin callback texts — idempotent,
  runs on every init (deferred one frame, see gotchas), so repo updates
  apply with one `reinitextensions`. build_component creates bare DATs only.
- Comp custom pars: Targetop (the table DAT), Headerrow (first row renders
  as the sticky header), Webroot, Port (9981), Refresh (pulse),
  Openviewer (pulse → window1), Openinbrowser (pulse); Style page
  (created by `_ensureSetup`): Bg/Panel/Cell/Cellalt/Grid/Header/Gutter/
  Text/Textdim/Accentcolor RGB, Fontfamily, Fontsize, Rowheight, Theme
  menu (custom/dark/light/synthwave presets write the color pars via
  `ApplyTheme`, coalesced through `OnStyleChange`).
- Selection outputs: the grid streams its selection (debounced 150ms)
  over the WS; the ext mirrors it into `sel_rows` / `sel_cells` table
  DATs wired to outDATs — the comp has Lister-style DAT out connectors
  (out1 = selected rows, out2 = selected cell block).
- `ext.Open(path)` — retarget + pop the window in one call; this is the
  hook for Vincent's ctrl.t keyboardin macro (his ListerUI workflow).

## Verified TD gotchas (inherited from TD-WEBgui-controller, 2025.32820 / CEF 132)

These were all learned the hard way in the sibling repo — same transport,
same traps. See that repo's CLAUDE.md for the war stories.

- Creating a webserverDAT **auto-creates a template `<name>_callbacks` DAT**;
  a same-named DAT you create gets auto-renamed and silently shadowed.
  Destroy the template, then create the file-synced one.
- **keyboardinDAT splits the same way**: its body is the read-only key-log
  table; callbacks go in the auto-created `<name>_callbacks`. 2025.32820
  signature is `onKey(dat, keyInfo)` (namedtuple), key names lowercase
  short forms (`tab esc enter backspace`). Gate with `par.panels`.
- webrenderTOP `par.active` defaults **OFF**; `outputresolution` defaults
  `useinput`. Chromium won't start until both are set. After a CEF
  "Unable to read cef messages" error, pulse `autorestartpulse`.
- `interactMouse(u, v, left=)` takes **bottom-origin normalized** coords —
  1:1 with panel CHOP u/v. Panel `u`/`v` only track during left
  interactions; `insideu`/`insidev` track rollover — hover moves and
  right-clicks must use the inside pair.
- `interactMouse(wheel=n)` is in **notches** (1 → 120px deltaY, sign
  inverted); panel CHOP `wheel` is an instantaneous displacement — forward
  1:1, don't delta it.
- webrenderTOP has **no keyboard injection** — keyboardin → `ForwardKey` →
  `executeJavaScript` → `window.__tdKey` routes keys into the page.
  Critical here: a table editor is mostly typing. External browsers type
  natively.
- **Mutating the comp during extension `__init__` trips a cook dependency
  loop that silently DISABLES the parexec** — `_ensureSetup()` is deferred
  via `run(delayFrames=1)`. Verify parexec health with storage
  side-effects, not prints.
- **Offscreen CEF stops dispatching WS messages once its stream goes
  quiet** — only a DOM-mutating executeJavaScript with forced layout
  revives it (`_kickWebrender()` after every table/delta broadcast burst).
- Offscreen CEF does **not render native popups** — no `<select>`, no OS
  context menu. All menus/popovers must be in-page DOM.
- `webrenderTOP par.reload.pulse()` is a **no-op** — use
  `executeJavaScript("location.reload()")`. webserver_callbacks sends
  `Cache-Control: no-cache` so reloads pick up fresh js/css.
- **syncfile cuts both ways: TD undo rolls a DAT back and syncfile writes
  the OLD text over the repo file.** Commit before risky TD-side sessions;
  `git restore` is the recovery.
- `reinitextensions` wipes instance state while WS connections stay open —
  seed `self.clients` from `webserverDAT.webSocketConnections` in
  `__init__`.
- Custom par names: first char uppercase, rest lowercase ASCII only.
- TD's `open()` defaults to **ASCII** — `exec(open(path).read())` on any
  file with UTF-8 (em-dashes!) raises UnicodeDecodeError. Always
  `open(path, encoding='utf-8')` (verified live 2025.32820).
- The DAT lock python attribute is **`OP.lock`** — `.locked` does not
  exist on tableDAT (AttributeError, verified live). windowCOMP open
  state is **`.isOpen`** (never `par.winopen.eval()` — pulse pars read
  False).
- DAT row/col structural APIs vary by build — structural ops here go
  through `_rewrite()` (clear + appendRow from the edited snapshot), which
  is version-proof and atomic enough for one datexec fire. Verify any
  direct insertRow/deleteRow use live before relying on it.

## Testing

- **No TD:** open `web/index.html?mock=1` in any browser — loopback bridge
  with a built-in demo table; the mock applies all edit ops (cell writes,
  insert/delete/move rows & cols, header toggle) so the grid is fully
  testable offline. Fastest loop for grid/CSS work. `.claude/launch.json`
  has `web-mock` on :8125; cache-bust with `&v=Date.now()` (python's
  http.server sends no cache headers).
- **With TD (via twozero_td MCP):**
  - `curl http://127.0.0.1:9981/` → 200 means webserver up.
  - Web→TD: `web.executeJavaScript("Bridge.send({t:'edit',edits:[{r:1,c:1,v:'x'}]})")`
    then `td_read_dat` the target. Exercises the real WS path.
  - TD→web: write a cell from Python, screenshot `webrender1`.
  - Perf: `td_get_perf` on the comp — ~0.0% cook budget at idle.

## Conventions

- `td/*.py`: tabs (TD convention), TD-style docstrings. `web/js`: 2-space,
  no framework, no build step — dependency-free and servable as-is.
- Wire coordinates are DAT coordinates, always. View state (sort, filter,
  column widths, selection) never crosses the wire and never mutates the
  table.
- TD is the source of truth: every DAT change (from any client, from TD
  scripts, from the network) broadcasts to every client; clients render
  optimistically but yield to broadcasts.
- Column widths persist in localStorage keyed by DAT path
  (`tdtable:<path>:colw`); table-attached prefs that should follow the
  project go in `specs/` later (see sprintboard M5).
