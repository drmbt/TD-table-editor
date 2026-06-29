/*
 * Grid: virtualized spreadsheet-style table view/editor.
 *
 * Owns ALL view state — sort, filter, column widths, selection — none of it
 * ever reaches TD or mutates the table (Lister semantics). Wire coordinates
 * are DAT coordinates: the grid maps view rows -> DAT rows before invoking
 * any callback.
 *
 * Callbacks (all receive DAT coordinates):
 *   edit(edits)              [{r,c,v}]
 *   insertRows(at, rows)     rows: array of value-arrays ([] = blank)
 *   deleteRows(rows)
 *   moveRows(rows, to)       to: pre-removal DAT insertion index
 *   insertCols(at, count)
 *   deleteCols(cols)
 *   status(info)             {dims, sel, note} for the status bar
 */
const Grid = (() => {
  let ROWH = 26;           // synced with the --rowh CSS var via setStyle
  const DEFW = 110;
  const MINW = 40;
  const MAXAUTO = 420;     // auto-sizing cap; manual resize can exceed it
  const OVERSCAN = 6;
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  let el, cbs;
  let body, spacer, rowsEl, colheadInner, gutterInner, emptyEl, clip;
  let editInput = null;
  let dropline = null;
  let ctxEl = null;

  let T = null;            // {path,name,editable,headerRow,cells}
  let colW = [];           // base widths (auto-sized or user-resized, persisted)
  let colFmt = {};         // per-column format views ({c:'checkbox'}, persisted)
  let colHide = {};        // hidden columns ({c:true}, persisted) — view only:
                           // the DATA stays in the DAT; sel_rows and callbacks
                           // carry full rows (hidden target/meta columns)
  // colDefine (comp DAT, project-portable) — wins over the localStorage
  // view state above when entries exist. srcOver styles DAT-backed
  // columns; uiDefs are VIRTUAL columns appended after the table columns
  // (button/thumb/eval content, never selectable/editable).
  let srcOver = {};        // datCol -> def
  let uiDefs = [];         // virtual column defs (in order)
  let uiVals = {};         // {defName: [val per DAT row]} (expr results)
  let vW = [];             // virtual column widths (session-only)
  let eW = [];             // effective widths: base + leftover into fillIdx
  let fillIdx = -1;        // content-richest column absorbs spare viewport width
  let sortCol = -1;
  let sortDir = 0;         // 0 none, 1 asc, -1 desc
  let filterStr = '';
  let viewRows = [];       // DAT row indices, header excluded
  let sel = null;          // ACTIVE rect {ar,ac,er,ec} in view coords
  let extraSels = [];      // additional rects from ctrl/cmd multi-select
  let editing = null;      // {vr,c}
  let renderQueued = false;
  // interactMouse never synthesizes a native dblclick in offscreen CEF, so
  // double-press is detected manually (also covers external browsers)
  let lastPress = { vr: -1, c: -1, t: 0 };
  let selTimer = null;     // debounced selection -> TD (sel_rows/sel_cells)
  let lastSelSent = '';
  let colDrop = null;      // vertical dropline for column drag-reorder

  // ---- coordinate helpers --------------------------------------------------

  const headOff = () => (T && T.headerRow ? 1 : 0);
  const numCols = () => (T && T.cells.length ? T.cells[0].length : 0);
  const datR = (vr) => viewRows[vr];
  const val = (r, c) => (T.cells[r] && T.cells[r][c] !== undefined ? T.cells[r][c] : '');
  const colLetter = (c) => {
    let s = '';
    c += 1;
    while (c > 0) { c -= 1; s = LETTERS[c % 26] + s; c = Math.floor(c / 26); }
    return s;
  };
  const totalW = () => eW.reduce((a, b) => a + b, 0);
  const colLeft = (c) => eW.slice(0, c).reduce((a, b) => a + b, 0);
  const colAt = (x) => {
    let acc = 0;
    for (let c = 0; c < eW.length; c++) {
      acc += eW[c];
      if (x < acc) return c;
    }
    return eW.length - 1;
  };
  const normRect = (r) => ({
    r0: Math.min(r.ar, r.er), r1: Math.max(r.ar, r.er),
    c0: Math.min(r.ac, r.ec), c1: Math.max(r.ac, r.ec),
  });
  const normSel = () => sel && normRect(sel);
  const allRects = () => (sel ? [...extraSels, sel] : extraSels.slice()).map(normRect);
  const fullWidth = (r) => r.c0 === 0 && r.c1 === numCols() - 1;
  const viewReorderable = () => T && T.editable && sortDir === 0 && !filterStr;

  // selected DAT rows across every rect, in view order (whole-row ops)
  function selDatRows() {
    const have = new Set();
    for (const r of allRects()) {
      for (let vr = r.r0; vr <= Math.min(r.r1, viewRows.length - 1); vr++) {
        have.add(viewRows[vr]);
      }
    }
    return viewRows.filter((dr) => have.has(dr));
  }

  // ---- view computation ------------------------------------------------------

  function recomputeView() {
    viewRows = [];
    if (!T) return;
    const f = filterStr.toLowerCase();
    for (let r = headOff(); r < T.cells.length; r++) {
      if (f && !T.cells[r].some((v) => v.toLowerCase().includes(f))) continue;
      viewRows.push(r);
    }
    if (sortDir !== 0 && sortCol >= 0 && sortCol < numCols()) {
      const keyed = viewRows.map((r, i) => {
        const v = val(r, sortCol);
        const n = v === '' ? NaN : Number(v);
        return { r, i, n, s: v.toLowerCase() };
      });
      keyed.sort((a, b) => {
        let d;
        const an = !Number.isNaN(a.n);
        const bn = !Number.isNaN(b.n);
        if (an && bn) d = a.n - b.n;
        else if (an !== bn) d = an ? -1 : 1;     // numbers before strings
        else d = a.s < b.s ? -1 : (a.s > b.s ? 1 : 0);
        return (d || a.i - b.i) * sortDir;       // stable
      });
      viewRows = keyed.map((k) => k.r);
    }
  }

  function clampSel() {
    const maxR = viewRows.length - 1;
    const maxC = numCols() - 1;
    if (maxR < 0 || maxC < 0) { sel = null; extraSels = []; return; }
    const clampRect = (r) => {
      for (const k of ['ar', 'er']) r[k] = Math.max(0, Math.min(r[k], maxR));
      for (const k of ['ac', 'ec']) r[k] = Math.max(0, Math.min(r[k], maxC));
    };
    if (sel) clampRect(sel);
    extraSels.forEach(clampRect);
  }

  // ---- rendering ----------------------------------------------------------------

  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function renderHead() {
    colheadInner.textContent = '';
    if (!T) return;
    const frag = document.createDocumentFragment();
    for (let c = 0; c < totCols(); c++) {
      if (effHide(c)) continue;
      const h = document.createElement('div');
      h.className = 'hcell' + (isVirt(c) ? ' virt' : '');
      h.style.width = eW[c] + 'px';
      h.dataset.c = c;
      if (isVirt(c)) {
        h.textContent = vDef(c) ? vDef(c).label : '';
      } else if (srcOver[c] && srcOver[c].label !== colName(c)) {
        h.textContent = srcOver[c].label;
      } else {
        h.textContent = T.headerRow ? (val(0, c) || colLetter(c)) : colLetter(c);
      }
      if (sortDir !== 0 && c === sortCol) {
        const m = document.createElement('span');
        m.className = 'sortmark';
        m.textContent = sortDir > 0 ? '▲' : '▼';
        h.appendChild(m);
      }
      const rz = document.createElement('div');
      rz.className = 'hresize';
      rz.dataset.c = c;
      h.appendChild(rz);
      frag.appendChild(h);
    }
    colheadInner.style.display = 'flex';
    colheadInner.appendChild(frag);
  }

  function render() {
    if (!T || !T.cells.length || !numCols()) {
      rowsEl.textContent = '';
      gutterInner.textContent = '';
      spacer.style.width = '0px';
      spacer.style.height = '0px';
      emptyEl.hidden = false;
      emptyEl.textContent = T && T.path ? 'EMPTY TABLE' : 'NO TARGET TABLE';
      pushStatus();
      return;
    }
    emptyEl.hidden = true;
    spacer.style.width = totalW() + 'px';
    spacer.style.height = (viewRows.length * ROWH) + 'px';

    const top = body.scrollTop;
    const first = Math.max(0, Math.floor(top / ROWH) - OVERSCAN);
    const last = Math.min(viewRows.length - 1,
      Math.ceil((top + body.clientHeight) / ROWH) + OVERSCAN);
    const rects = allRects();
    const inAny = (vr, c) => rects.some((r) =>
      vr >= r.r0 && vr <= r.r1 && c >= r.c0 && c <= r.c1);
    const rowInAny = (vr) => rects.some((r) => vr >= r.r0 && vr <= r.r1);

    const frag = document.createDocumentFragment();
    const gfrag = document.createDocumentFragment();
    for (let vr = first; vr <= last; vr++) {
      const r = datR(vr);
      const row = document.createElement('div');
      row.className = 'vrow' + (vr % 2 ? ' alt' : '');
      row.style.top = (vr * ROWH) + 'px';
      for (let c = 0; c < totCols(); c++) {
        if (effHide(c)) continue;
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.style.width = eW[c] + 'px';
        cell.dataset.vr = vr;
        cell.dataset.c = c;
        const fmt = effFmt(c);
        const def = isVirt(c) ? vDef(c) : srcOver[c];
        if (isVirt(c)) cell.classList.add('cell-clickable');   // clickable
        // cell content source: DAT value, or for virtual/expr columns the
        // TD-evaluated expr result shipped in uivals
        const content = def && def.expr
          ? ((uiVals[def.name] || [])[r] || '')
          : (isVirt(c) ? '' : val(r, c));
        if (fmt === 'checkbox') {
          cell.textContent = checkboxOn(content) ? '☑' : '☐';
          cell.classList.add('fmt-checkbox');
        } else if (fmt === 'button') {
          const b = document.createElement('div');
          b.className = 'cellbtn';
          if (def && def.icon) {
            const img = document.createElement('img');
            img.className = 'cellthumb';
            img.src = 'thumb?src=' + encodeURIComponent(def.icon);
            img.style.height = (ROWH - 8) + 'px';
            img.addEventListener('error', () => {
              b.textContent = isVirt(c) ? def.label : content;
            }, { once: true });
            b.appendChild(img);
          } else {
            b.textContent = isVirt(c) && def ? def.label : content;
          }
          cell.classList.add('fmt-button');
          cell.appendChild(b);
        } else if (fmt === 'thumb' && content) {
          const img = document.createElement('img');
          img.className = 'cellthumb';
          img.src = 'thumb?src=' + encodeURIComponent(content);
          img.style.height = (ROWH - 4) + 'px';
          // no endpoint (mock) or bad path: fall back to the raw text
          img.addEventListener('error', () => {
            cell.textContent = content;
          }, { once: true });
          cell.classList.add('fmt-thumb');
          cell.appendChild(img);
        } else if (fmt === 'delete') {
          const b = document.createElement('div');
          b.className = 'cellbtn celldelete';
          b.textContent = '✕';
          b.title = 'Delete row';
          cell.classList.add('fmt-button');
          cell.appendChild(b);
        } else {
          cell.textContent = content;
        }
        if (inAny(vr, c)) cell.classList.add('sel');
        // row selections (gutter) read as rows — no active-cell outline
        if (sel && !sel.rowMode && vr === sel.ar && c === sel.ac) cell.classList.add('cur');
        row.appendChild(cell);
      }
      frag.appendChild(row);

      const g = document.createElement('div');
      g.className = 'gcell';
      g.style.top = (vr * ROWH) + 'px';
      g.dataset.vr = vr;
      g.textContent = r;                     // DAT row index, on purpose
      if (rowInAny(vr)) g.classList.add('sel');
      gfrag.appendChild(g);
    }
    rowsEl.textContent = '';
    rowsEl.appendChild(frag);
    gutterInner.textContent = '';
    gutterInner.appendChild(gfrag);
    pushStatus();
  }

  function renderAll() {
    recomputeView();
    clampSel();
    updateEff();
    renderHead();
    render();
  }

  function pushStatus() {
    if (!cbs.status) return;
    let dims = '';
    let selInfo = '';
    if (T && T.cells.length) {
      dims = `${T.cells.length}×${numCols()}`;
      if (viewRows.length !== T.cells.length - headOff()) {
        dims += ` (${viewRows.length} shown)`;
      }
    }
    const s = normSel();
    if (extraSels.length) {
      selInfo = `${selDatRows().length} rows / ${extraSels.length + (sel ? 1 : 0)} areas`;
    } else if (s) {
      const nr = s.r1 - s.r0 + 1;
      const nc = s.c1 - s.c0 + 1;
      selInfo = nr * nc > 1 ? `${nr}×${nc} selected`
        : `r${datR(sel.ar)} c${sel.ac}`;
    }
    cbs.status({ dims, sel: selInfo,
      sortApplicable: !!(T && T.editable && sortDir !== 0 && !filterStr) });
    queueSelSend();
  }

  // selection -> TD, debounced: the ext mirrors it into the comp's
  // sel_rows / sel_cells output DATs (Lister-style selection outputs)
  function selPayload() {
    const s = normSel();
    if (!s || !T || !T.cells.length) return null;
    return { rows: selDatRows(), c0: s.c0, c1: s.c1 };
  }

  function queueSelSend() {
    if (!cbs.select) return;
    const key = JSON.stringify(selPayload());
    if (key === lastSelSent) return;
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      lastSelSent = key;
      cbs.select(selPayload());
    }, 150);
  }

  // ---- table data in/out ----------------------------------------------------------

  // content-aware sizing: short columns stay narrow, long-text columns get
  // medium/capped widths, and the content-richest column (fillIdx) absorbs
  // any spare viewport width so the grid always fills the panel
  function computeAuto() {
    const n = numCols();
    const maxCh = Array(n).fill(2);
    const sample = Math.min(T.cells.length, 500);
    for (let r = 0; r < sample; r++) {
      const row = T.cells[r];
      for (let c = 0; c < n; c++) {
        const len = (row[c] || '').length;
        if (len > maxCh[c]) maxCh[c] = len;
      }
    }
    const px = Math.round((parseFloat(getComputedStyle(document.body).fontSize) || 13) * 0.58);
    const w = maxCh.map((m) => Math.max(MINW, Math.min(22 + m * px, MAXAUTO)));
    return { w, maxCh };
  }

  function loadColW() {
    const n = numCols();
    if (!n) { colW = []; eW = []; fillIdx = -1; return; }
    const auto = computeAuto();
    fillIdx = auto.maxCh.indexOf(Math.max(...auto.maxCh));
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem('tdtable:' + T.path + ':colw'));
    } catch (e) { /* fresh */ }
    colW = Array.from({ length: n }, (_, i) => {
      // colDefine width wins (portable, set by a manual resize); then the
      // saved localStorage width; then the content-aware auto width
      const cw = srcOver[i] ? parseInt(srcOver[i].width, 10) : NaN;
      if (Number.isFinite(cw) && cw > 0) return Math.max(MINW, cw);
      return (saved && typeof saved[i] === 'number') ? Math.max(MINW, saved[i]) : auto.w[i];
    });
  }

  function updateEff() {
    eW = colW.slice().concat(vW);    // DAT columns then virtual columns
    if (!eW.length || !body) return;
    for (let c = 0; c < eW.length; c++) { if (effHide(c)) eW[c] = 0; }
    const leftover = body.clientWidth - eW.reduce((a, b) => a + b, 0);
    if (leftover > 0) {
      // spare width goes to a visible DAT column, never a virtual one
      let f = fillIdx >= 0 && fillIdx < numCols() && !effHide(fillIdx)
        ? fillIdx : -1;
      if (f < 0) f = nextVisCol(numCols() - 1, -1);
      if (f >= 0) eW[f] += leftover;
    }
  }

  function saveColW() {
    try {
      localStorage.setItem('tdtable:' + T.path + ':colw', JSON.stringify(colW));
    } catch (e) { /* private mode etc. */ }
  }

  // persist a resized column's width: into its colDefine entry when the
  // table is configured (portable, travels with the comp), else into
  // localStorage (zero-config fallback)
  function persistColW(c) {
    if (configured() && !isVirt(c) && srcOver[c] && cbs.setColDef) {
      cbs.setColDef([{ column: srcOver[c].name,
        set: { width: String(Math.round(colW[c])) } }]);
    } else {
      saveColW();
    }
  }

  // per-column format views ({colIndex: 'checkbox'}) and hidden columns,
  // persisted like widths; view state only — cells still hold plain text
  function loadFmt() {
    colFmt = {};
    colHide = {};
    try {
      colFmt = JSON.parse(localStorage.getItem('tdtable:' + T.path + ':fmt')) || {};
    } catch (e) { /* fresh */ }
    try {
      colHide = JSON.parse(localStorage.getItem('tdtable:' + T.path + ':hide')) || {};
    } catch (e) { /* fresh */ }
  }

  function saveFmt() {
    try {
      localStorage.setItem('tdtable:' + T.path + ':fmt', JSON.stringify(colFmt));
      localStorage.setItem('tdtable:' + T.path + ':hide', JSON.stringify(colHide));
    } catch (e) { /* private mode etc. */ }
  }

  // "Reset config" pulse from the ext ({t:resetview}): drop saved view
  // state for this target so the grid re-derives auto widths/formats. The
  // colDefine is cleared TD-side; the follow-up same-path table broadcast
  // won't reload storage, so reset the in-memory copies here too.
  function resetView(path) {
    const p = path || (T && T.path);
    if (p) {
      try {
        localStorage.removeItem('tdtable:' + p + ':colw');
        localStorage.removeItem('tdtable:' + p + ':fmt');
        localStorage.removeItem('tdtable:' + p + ':hide');
      } catch (e) { /* private mode etc. */ }
    }
    if (T) { loadFmt(); loadColW(); renderAll(); }
  }

  // formats/visibility follow their column through a drag-reorder
  function moveFmt(c, gap) {
    const remap = (m) => {
      const arr = Array.from({ length: numCols() }, (_, i) => m[i]);
      const f = arr.splice(c, 1)[0];
      arr.splice(gap - (c < gap ? 1 : 0), 0, f);
      const out = {};
      arr.forEach((v, i) => { if (v) out[i] = v; });
      return out;
    };
    colFmt = remap(colFmt);
    colHide = remap(colHide);
  }

  // ---- effective column properties: colDefine entry > localStorage ------

  const totCols = () => numCols() + uiDefs.length;
  const isVirt = (c) => c >= numCols();
  const vDef = (c) => uiDefs[c - numCols()];
  const colName = (c) =>
    (T && T.headerRow ? val(0, c) : 'c' + c) || 'c' + c;
  const configured = () => uiDefs.length > 0 || Object.keys(srcOver).length > 0;

  function effFmt(c) {
    if (isVirt(c)) return vDef(c) ? vDef(c).mode : 'text';
    if (srcOver[c]) return srcOver[c].mode || 'text';
    return colFmt[c] || 'text';
  }

  function effHide(c) {
    if (isVirt(c)) return vDef(c) ? !vDef(c).visible : false;
    if (srcOver[c]) return !srcOver[c].visible;
    return !!colHide[c];
  }

  function effEditable(c) {
    if (isVirt(c)) return false;
    if (srcOver[c]) return srcOver[c].editable;
    return true;
  }

  const hiddenCount = () => {
    let n = 0;
    for (let c = 0; c < numCols(); c++) { if (effHide(c)) n++; }
    return n;
  };

  // next visible DAT column from c moving dir (skips hidden); -1 if none
  function nextVisCol(c, dir) {
    for (let i = c; i >= 0 && i < numCols(); i += dir) {
      if (!effHide(i)) return i;
    }
    return -1;
  }

  const checkboxOn = (v) => {
    const t = String(v).trim();
    return t !== '' && t !== '0';
  };

  // single click toggles 0↔1 immediately (empty -> 1); no edit mode
  function toggleCheckbox(vr, c) {
    if (!T || !T.editable) return;
    const r = datR(vr);
    const on = checkboxOn(val(r, c));
    localEdit([{ r, c, v: on ? '0' : '1' }],
      `toggle r${r} c${c} ${on ? 'off' : 'on'}`);
  }

  // clickable cells: any virtual UI column (clickable by default), or a
  // button-format DAT column. Flash, fire {t:button} (-> onClick<Column> /
  // onButtonClick / onClick) with the FULL row incl. hidden columns, and
  // run the built-in action for `delete` mode. Non-destructive modes work
  // on read-only tables (they only read).
  function clickCell(vr, c, targetEl) {
    const r = datR(vr);
    const def = isVirt(c) ? vDef(c) : null;
    const fl = targetEl && targetEl.closest
      ? (targetEl.closest('.cellbtn') || targetEl.closest('.cellthumb')) : null;
    if (fl) {
      fl.classList.add('pressed');
      setTimeout(() => fl.classList.remove('pressed'), 120);
    }
    const name = def ? def.name : '';
    log(`click ${name ? '"' + name + '"' : 'c' + c} r${r}`);
    if (cbs.button) cbs.button(r, isVirt(c) ? -1 : c, name);
    if (def && def.mode === 'delete' && T && T.editable) {
      structOp(() => cbs.deleteRows([r]), `delete row ${r}`);
    }
  }

  // colDefine spec from the ext: split into DAT-column overrides and
  // virtual columns; virtual widths come from the def (session resize ok)
  function applyUiCols(defs, vals) {
    srcOver = {};
    uiDefs = [];
    for (const d of defs) {
      if (d.src >= 0) srcOver[d.src] = d;
      else uiDefs.push(d);
    }
    vW = uiDefs.map((d) => {
      const w = parseInt(d.width, 10);
      return Number.isFinite(w) && w > 0 ? Math.max(MINW, w) : DEFW;
    });
    uiVals = vals || {};
  }

  // fresh expr results after a delta ({t:uivals})
  function setUiVals(vals) {
    uiVals = vals || {};
    render();
  }

  function setTable(t) {
    const samePath = T && T.path === t.path;
    cancelEdit();
    T = t;
    applyUiCols(t.uicols || [], t.uivals || {});
    if (!samePath) loadFmt();
    // widths are sourced from colDefine (portable) / localStorage every
    // broadcast, so re-derive each time: this applies a colDefine width
    // change and re-picks the fill column
    loadColW();
    if (!samePath) {
      sortCol = -1;
      sortDir = 0;
      sel = null;
      extraSels = [];
      body.scrollTop = 0;
      history = [];
      histPos = 0;
    }
    renderAll();
  }

  function applyEdits(edits) {
    if (!T) return;
    for (const e of edits) {
      if (T.cells[e.r] && e.c >= 0 && e.c < T.cells[e.r].length) {
        T.cells[e.r][e.c] = String(e.v ?? '');
      }
    }
    // a sorted/filtered view may need re-keying; cheap at these sizes
    if (sortDir !== 0 || filterStr) recomputeView();
    renderHead();
    render();
  }

  function applyAndSend(edits) {
    for (const e of edits) {
      if (T.cells[e.r] && e.c >= 0 && e.c < T.cells[e.r].length) {
        T.cells[e.r][e.c] = e.v;
      }
    }
    cbs.edit(edits);
    if (sortDir !== 0 || filterStr) recomputeView();
    renderHead();
    render();
  }

  // ---- undo/redo --------------------------------------------------------------
  // Client-side history for edits made from THIS page. Cell edits store
  // inverse value lists; structural ops store a whole-table snapshot and
  // undo via {t:replace} (the inverse of insert/delete/move is a restore).
  // Single-editor assumption: an undo replays over concurrent edits.

  const HIST_MAX = 100;
  let history = [];
  let histPos = 0;

  function pushHist(entry) {
    history.length = histPos;          // drop any redo tail
    history.push(entry);
    if (history.length > HIST_MAX) history.shift();
    histPos = history.length;
  }

  // footer action log (main.js shows it when the comp's Displaylog is on)
  function log(msg) {
    if (cbs.log && msg) cbs.log(msg);
  }

  function localEdit(edits, label) {
    const prev = edits.map((e) => ({ r: e.r, c: e.c, v: val(e.r, e.c) }));
    pushHist({ kind: 'edit', undo: prev,
      redo: edits.map((e) => ({ r: e.r, c: e.c, v: e.v })) });
    log(label || `edit ${edits.length} cell${edits.length > 1 ? 's' : ''}`);
    applyAndSend(edits);
  }

  // wrap a structural send with a pre-op snapshot for undo
  function structOp(send, label) {
    if (!T || !T.editable) return;
    pushHist({ kind: 'table', pre: T.cells.map((row) => row.slice()) });
    log(label);
    send();
  }

  function restoreCells(cells) {
    cbs.replace(cells.map((row) => row.slice()));
    T.cells = cells.map((row) => row.slice());   // optimistic
    renderAll();
  }

  function undo() {
    if (!T || !T.editable || histPos === 0) return;
    histPos--;
    const h = history[histPos];
    log('undo');
    if (h.kind === 'edit') {
      applyAndSend(h.undo.map((e) => ({ ...e })));
    } else {
      h.post = T.cells.map((row) => row.slice());   // for redo
      restoreCells(h.pre);
    }
  }

  function redo() {
    if (!T || !T.editable || histPos >= history.length) return;
    const h = history[histPos];
    histPos++;
    log('redo');
    if (h.kind === 'edit') applyAndSend(h.redo.map((e) => ({ ...e })));
    else if (h.post) restoreCells(h.post);
  }

  // ---- selection & navigation --------------------------------------------------

  function setAnchor(vr, c, extend) {
    vr = Math.max(0, Math.min(vr, viewRows.length - 1));
    c = Math.max(0, Math.min(c, numCols() - 1));
    if (effHide(c)) {                 // never anchor on a hidden column
      const t = nextVisCol(c, -1);
      c = t >= 0 ? t : nextVisCol(c, 1);
      if (c < 0) return;
    }
    if (extend && sel) { sel.er = vr; sel.ec = c; delete sel.rowMode; }
    else { sel = { ar: vr, ac: c, er: vr, ec: c }; extraSels = []; }
    scrollTo(vr, c);
    render();
  }

  function scrollTo(vr, c) {
    const top = vr * ROWH;
    if (top < body.scrollTop) body.scrollTop = top;
    else if (top + ROWH > body.scrollTop + body.clientHeight) {
      body.scrollTop = top + ROWH - body.clientHeight;
    }
    const left = colLeft(c);
    if (left < body.scrollLeft) body.scrollLeft = left;
    else if (left + eW[c] > body.scrollLeft + body.clientWidth) {
      body.scrollLeft = left + eW[c] - body.clientWidth;
    }
  }

  function move(dr, dc, extend) {
    if (!sel) { setAnchor(0, nextVisCol(0, 1), false); return; }
    const fr = extend ? sel.er : sel.ar;
    const fc = extend ? sel.ec : sel.ac;
    let tc = fc;
    if (dc) {                       // horizontal steps skip hidden columns
      const t = nextVisCol(fc + dc, dc > 0 ? 1 : -1);
      if (t >= 0) tc = t;
    }
    setAnchor(fr + dr, tc, extend);
  }

  // ---- editing -------------------------------------------------------------------

  function startEdit(vr, c, initial) {
    if (!T || !T.editable || vr < 0 || vr >= viewRows.length) return;
    if (isVirt(c) || !effEditable(c)) return;
    if (editing && editing.vr === vr && editing.c === c) return;
    cancelEdit();
    editing = { vr, c };
    editInput = document.createElement('input');
    editInput.id = 'celledit';
    editInput.value = initial !== undefined ? initial : val(datR(vr), c);
    editInput.style.top = (vr * ROWH) + 'px';
    editInput.style.left = colLeft(c) + 'px';
    editInput.style.width = eW[c] + 'px';
    editInput.style.height = ROWH + 'px';
    spacer.appendChild(editInput);
    editInput.focus();
    if (initial === undefined) editInput.select();
    editInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { commitEdit(e.shiftKey ? -1 : 1, 0); e.preventDefault(); }
      else if (e.key === 'Tab') { commitEdit(0, e.shiftKey ? -1 : 1); e.preventDefault(); }
      else if (e.key === 'Escape') { cancelEdit(); e.preventDefault(); }
    });
    editInput.addEventListener('pointerdown', (e) => e.stopPropagation());
    editInput.addEventListener('blur', () => { if (editing) commitEdit(0, 0); });
  }

  function commitEdit(dr, dc) {
    if (!editing) return;
    const { vr, c } = editing;
    const v = editInput.value;
    removeEditInput();
    if (v !== val(datR(vr), c)) {
      localEdit([{ r: datR(vr), c, v }], `edit r${datR(vr)} c${c}`);
    }
    clip.focus({ preventScroll: true });
    if (dr || dc) move(dr, dc, false);
  }

  function cancelEdit() {
    if (!editing) return;
    removeEditInput();
    clip.focus({ preventScroll: true });
    render();
  }

  function removeEditInput() {
    editing = null;
    if (editInput) { editInput.remove(); editInput = null; }
  }

  // Shared caret/selection engine for in-TD text inputs (cell editor,
  // header rename, filter). TD keystrokes arrive via executeJavaScript,
  // so inputs never see native key events — caret and selection are
  // driven through selectionStart/End here. Mac semantics: alt = word
  // jump, cmd = text start/end, ctrl = word jump (win convention).
  // External browsers never reach this path (their inputs are native).
  // Returns true when the key was handled.
  function textKey(k, inp) {
    const v = inp.value;
    const ctrl = !!k.ctrl;
    const alt = !!k.alt;
    const cmd = !!k.cmd;
    const shift = !!k.shift;
    const word = ctrl || alt;
    const s = inp.selectionStart;
    const e = inp.selectionEnd;
    const back = inp.selectionDirection === 'backward';
    const f = back ? s : e;            // the moving (focus) end
    const wordL = (p) => {
      while (p > 0 && !/\w/.test(v[p - 1])) p--;
      while (p > 0 && /\w/.test(v[p - 1])) p--;
      return p;
    };
    const wordR = (p) => {
      while (p < v.length && !/\w/.test(v[p])) p++;
      while (p < v.length && /\w/.test(v[p])) p++;
      return p;
    };
    const caret = (p) => inp.setSelectionRange(p, p);
    const moveTo = (p) => {            // shift extends from the anchor
      p = Math.max(0, Math.min(p, v.length));
      if (!shift) { caret(p); return; }
      const anchor = back ? e : s;
      inp.setSelectionRange(Math.min(anchor, p), Math.max(anchor, p),
        p < anchor ? 'backward' : 'forward');
    };
    switch (k.key) {
      case 'left':
        if (cmd) moveTo(0);
        else if (word) moveTo(wordL(f));
        else if (!shift && s !== e) caret(s);   // collapse to selection start
        else moveTo(f - 1);
        return true;
      case 'right':
        if (cmd) moveTo(v.length);
        else if (word) moveTo(wordR(f));
        else if (!shift && s !== e) caret(e);
        else moveTo(f + 1);
        return true;
      case 'home': case 'up': moveTo(0); return true;
      case 'end': case 'down': moveTo(v.length); return true;
      case 'backspace':
        if (s !== e) inp.setRangeText('', s, e, 'end');
        else if (cmd) inp.setRangeText('', 0, s, 'end');   // mac cmd+bksp
        else if (s > 0) inp.setRangeText('', word ? wordL(s) : s - 1, s, 'end');
        return true;
      case 'delete':
        if (s !== e) inp.setRangeText('', s, e, 'end');
        else if (s < v.length) inp.setRangeText('', s, word ? wordR(s) : s + 1, 'end');
        return true;
      default: break;
    }
    if ((ctrl || cmd) && k.key === 'a') {       // select all
      inp.setSelectionRange(0, v.length);
      return true;
    }
    if (k.ch && !ctrl && !cmd) {
      inp.setRangeText(k.ch, s, e, 'end');      // insert replaces selection
      return true;
    }
    return false;
  }

  function editorTDKey(k) {
    if (k.key === 'enter') { commitEdit(k.shift ? -1 : 1, 0); return; }
    if (k.key === 'tab') { commitEdit(0, k.shift ? -1 : 1); return; }
    if (k.key === 'esc') { cancelEdit(); return; }
    textKey(k, editInput);
  }

  function clearSelection() {
    if (!T || !T.editable) return;
    const edits = [];
    const seen = new Set();
    for (const s of allRects()) {
      for (let vr = s.r0; vr <= Math.min(s.r1, viewRows.length - 1); vr++) {
        for (let c = s.c0; c <= s.c1; c++) {
          if (effHide(c)) continue;        // never blind-clear hidden data
          const key = datR(vr) + ':' + c;
          if (seen.has(key)) continue;
          seen.add(key);
          if (val(datR(vr), c) !== '') edits.push({ r: datR(vr), c, v: '' });
        }
      }
    }
    if (edits.length) {
      localEdit(edits, `clear ${edits.length} cell${edits.length > 1 ? 's' : ''}`);
    }
  }

  // ctrl/cmd+d: duplicate the selected rows — copies land directly below
  // the last selected row (DAT coordinates, undoable as one structural op)
  function duplicateRows() {
    if (!T || !T.editable || !sel) return;
    const rows = selDatRows();
    if (!rows.length) return;
    const at = Math.max(...rows) + 1;
    const copies = rows.map((dr) => T.cells[dr].slice());
    structOp(() => cbs.insertRows(at, copies),
      `duplicate ${rows.length} row${rows.length > 1 ? 's' : ''}`);
    if (viewReorderable()) {       // select the duplicated block
      const start = at - headOff();
      sel = { ar: start, ac: 0, er: start + rows.length - 1,
        ec: numCols() - 1, rowMode: true };
      extraSels = [];
    }
  }

  // ---- clipboard --------------------------------------------------------------------

  function selectionTSV() {
    const rects = allRects();
    if (!rects.length) return '';
    // multiple full-width rects (ctrl-picked rows): copy the row union in
    // view order — the Lister-style "copy my picked rows" case. Otherwise
    // copy the active rect only (multi-area block copy is ill-defined).
    if (rects.length > 1 && rects.every(fullWidth)) {
      return selDatRows()
        .map((dr) => T.cells[dr].filter((_, c) => !effHide(c)).join('\t'))
        .join('\n');
    }
    const s = normSel() || rects[rects.length - 1];
    const lines = [];
    for (let vr = s.r0; vr <= Math.min(s.r1, viewRows.length - 1); vr++) {
      const cells = [];
      for (let c = s.c0; c <= s.c1; c++) {
        if (!effHide(c)) cells.push(val(datR(vr), c));
      }
      lines.push(cells.join('\t'));
    }
    return lines.join('\n');
  }

  function pasteTSV(text) {
    if (!T || !T.editable || !sel) return;
    const s = normSel();
    const rows = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
      .map((l) => l.split('\t'));
    if (!rows.length) return;
    const edits = [];
    // single cell copied onto a larger selection fills the selection
    if (rows.length === 1 && rows[0].length === 1
        && (s.r1 > s.r0 || s.c1 > s.c0)) {
      for (let vr = s.r0; vr <= s.r1; vr++) {
        for (let c = s.c0; c <= s.c1; c++) {
          if (effHide(c)) continue;
          edits.push({ r: datR(vr), c, v: rows[0][0] });
        }
      }
    } else {
      const maxW = Math.max(...rows.map((r) => r.length));
      const needRows = s.r0 + rows.length - viewRows.length;
      const needCols = s.c0 + maxW - numCols();
      // grow only without hidden cols — growing a view that doesn't show
      // every column is ambiguous; hidden setups clip like sorted views
      if ((needRows > 0 || needCols > 0) && viewReorderable()
          && !hiddenCount()) {
        // grow-on-paste: extend the table and write the block in ONE
        // undoable replace burst (only when view order == DAT order;
        // sorted/filtered views clip like before)
        const ncols = numCols() + Math.max(0, needCols);
        const grown = T.cells.map((r) => {
          const row = r.slice();
          while (row.length < ncols) row.push('');
          return row;
        });
        while (grown.length < T.cells.length + Math.max(0, needRows)) {
          grown.push(new Array(ncols).fill(''));
        }
        for (let i = 0; i < rows.length; i++) {
          const dr = headOff() + s.r0 + i;
          for (let j = 0; j < rows[i].length; j++) grown[dr][s.c0 + j] = rows[i][j];
        }
        structOp(() => cbs.replace(grown),
          `paste-grow to ${grown.length}×${ncols}`);
        T.cells = grown.map((r) => r.slice());   // optimistic
        sel.er = s.r0 + rows.length - 1;
        sel.ec = s.c0 + maxW - 1;
        renderAll();
        return;
      }
      // paste walks VISIBLE columns from the anchor — hidden target/meta
      // columns are never silently overwritten by a block paste
      const visCols = [];
      for (let c = s.c0; c < numCols(); c++) {
        if (!effHide(c)) visCols.push(c);
      }
      for (let i = 0; i < rows.length; i++) {
        const vr = s.r0 + i;
        if (vr >= viewRows.length) break;       // sorted/filtered: clip
        for (let j = 0; j < rows[i].length; j++) {
          if (j >= visCols.length) break;
          edits.push({ r: datR(vr), c: visCols[j], v: rows[i][j] });
        }
      }
      sel.er = Math.min(s.r0 + rows.length - 1, viewRows.length - 1);
      sel.ec = Math.min(s.c0 + rows[0].length - 1, numCols() - 1);
    }
    if (edits.length) {
      localEdit(edits, `paste ${edits.length} cell${edits.length > 1 ? 's' : ''}`);
    }
  }

  // ---- keyboard ------------------------------------------------------------------------

  function handleKey(e) {
    if (!T) return;
    const meta = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
      const dr = k === 'ArrowUp' ? -1 : (k === 'ArrowDown' ? 1 : 0);
      const dc = k === 'ArrowLeft' ? -1 : (k === 'ArrowRight' ? 1 : 0);
      if (meta) {
        const tr = dr ? (dr < 0 ? 0 : viewRows.length - 1) : (sel ? (e.shiftKey ? sel.er : sel.ar) : 0);
        const tc = dc ? (dc < 0 ? 0 : numCols() - 1) : (sel ? (e.shiftKey ? sel.ec : sel.ac) : 0);
        setAnchor(tr, tc, e.shiftKey);
      } else move(dr, dc, e.shiftKey);
      e.preventDefault();
    } else if (k === 'Tab') {
      move(0, e.shiftKey ? -1 : 1, false);
      e.preventDefault();
    } else if (k === 'Enter' || k === 'F2') {
      if (sel) startEdit(sel.ar, sel.ac);
      e.preventDefault();
    } else if (k === 'Delete' || k === 'Backspace') {
      clearSelection();
      e.preventDefault();
    } else if (meta && (k === 'a' || k === 'A')) {
      if (viewRows.length && numCols()) {
        sel = { ar: 0, ac: 0, er: viewRows.length - 1, ec: numCols() - 1 };
        extraSels = [];
        render();
      }
      e.preventDefault();
    } else if (k === 'Home' || k === 'End') {
      const last = numCols() - 1;
      if (meta) setAnchor(k === 'Home' ? 0 : viewRows.length - 1, k === 'Home' ? 0 : last, e.shiftKey);
      else if (sel) setAnchor(e.shiftKey ? sel.er : sel.ar, k === 'Home' ? 0 : last, e.shiftKey);
      e.preventDefault();
    } else if (k === 'PageUp' || k === 'PageDown') {
      const page = Math.max(1, Math.floor(body.clientHeight / ROWH) - 1);
      move(k === 'PageUp' ? -page : page, 0, e.shiftKey);
      e.preventDefault();
    } else if (k === 'Escape') {
      sel = null;
      extraSels = [];
      render();
    } else if (meta && (k === 'z' || k === 'Z')) {
      if (e.shiftKey) redo(); else undo();
      e.preventDefault();
    } else if (meta && (k === 'y' || k === 'Y')) {
      redo();
      e.preventDefault();
    } else if (meta && (k === 'd' || k === 'D')) {
      duplicateRows();
      e.preventDefault();
    } else if (k === ' ' && sel && effFmt(sel.ac) === 'checkbox') {
      toggleCheckbox(sel.ar, sel.ac);
      e.preventDefault();
    }
    // NOTE: no type-to-replace — editing starts only via double-click,
    // Enter or F2, so stray typing (e.g. aimed at the filter) never
    // overwrites cells
  }

  // TD in-panel keystrokes arrive via executeJavaScript (webrenderTOP has no
  // native key injection). Map TD's lowercase short names onto handleKey /
  // the live editor.
  const TD_KEYS = {
    enter: 'Enter', esc: 'Escape', tab: 'Tab', backspace: 'Backspace',
    delete: 'Delete', left: 'ArrowLeft', right: 'ArrowRight',
    up: 'ArrowUp', down: 'ArrowDown', home: 'Home', end: 'End',
    pgup: 'PageUp', pgdn: 'PageDown', f2: 'F2',
  };

  // a focused, editable text input (wizard fields, filter, header rename) —
  // not the grid's hidden clip or the cell editor (handled separately)
  function focusedInput() {
    const ae = document.activeElement;
    if (ae && ae !== clip && ae !== editInput
        && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')
        && ae.type !== 'checkbox' && ae.type !== 'radio') return ae;
    return null;
  }

  // move focus to the next/prev focusable control within a container —
  // drives in-TD Tab (external browsers traverse natively)
  function tabWithin(container, current, back) {
    const f = [...container.querySelectorAll('input, select, textarea, button')]
      .filter((e) => !e.disabled && e.tabIndex !== -1 && e.offsetParent !== null);
    if (!f.length) return;
    let i = f.indexOf(current);
    i = (i + (back ? -1 : 1) + f.length) % f.length;
    const n = f[i];
    n.focus();
    if (n.select && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA')) n.select();
  }

  window.__tdKey = (k) => {
    const ae = document.activeElement;
    // wizard Tab cycles its fields (in-TD; browsers traverse natively)
    if (k.key === 'tab' && wizEl && ae && wizEl.contains(ae)) {
      tabWithin(wizEl, ae, !!k.shift);
      return;
    }
    // a focused page input (e.g. the filter box) gets the keys — in-TD
    // keystrokes only arrive through here, so route them to whatever
    // editor has focus instead of the grid
    if (ae && ae !== clip && ae !== editInput
        && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
      if (k.key === 'esc') {
        // inputs with their own Escape semantics (header rename) cancel
        // via preventDefault; the default is the filter's clear-on-esc
        const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
        ae.dispatchEvent(ev);
        if (ev.defaultPrevented) return;
        ae.value = '';
        ae.blur();
        clip.focus({ preventScroll: true });
        ae.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      if (k.key === 'enter' || k.key === 'tab') {
        const ev = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
        ae.dispatchEvent(ev);
        if (!ev.defaultPrevented) {
          ae.blur();
          clip.focus({ preventScroll: true });
        }
        return;
      }
      // full text editing (caret nav, selection, word jumps) — same
      // engine as the cell editor; input event only on value change
      const before = ae.value;
      if (textKey(k, ae) && ae.value !== before) {
        ae.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    if (editing && editInput) { editorTDKey(k); return; }
    const key = TD_KEYS[k.key]
      || (k.key && k.key.length === 1 ? k.key : null)   // ctrl chords (z/y)
      || (k.ch && k.ch.length === 1 ? k.ch : null);
    if (key === null) return;
    handleKey({
      key, shiftKey: !!k.shift, ctrlKey: !!(k.ctrl || k.cmd), metaKey: false,
      preventDefault: () => {},
    });
  };

  // In-TD clipboard rides through TD (offscreen CEF has no OS clipboard):
  // keyboardin ctrl+c/x -> ForwardKey -> __tdCopy -> TSV over the WS ->
  // ext sets ui.clipboard; ctrl+v -> ext reads ui.clipboard -> __tdPaste.
  window.__tdCopy = (cut) => {
    if (editing && editInput) {
      // copy/cut the editor's text selection (whole value if collapsed)
      const s = editInput.selectionStart;
      const e = editInput.selectionEnd;
      const text = s === e ? editInput.value : editInput.value.slice(s, e);
      if (text && cbs.clip) cbs.clip(text);
      if (cut) {
        if (s !== e) editInput.setRangeText('', s, e, 'end');
        else editInput.value = '';
      }
      return;
    }
    // any other focused text input (wizard fields, filter, rename): copy/
    // cut its text selection through the OS clipboard (ui.clipboard)
    const inp = focusedInput();
    if (inp) {
      const s = inp.selectionStart, e = inp.selectionEnd;
      const has = s != null && e != null && s !== e;
      const text = has ? inp.value.slice(s, e) : inp.value;
      if (text && cbs.clip) cbs.clip(text);
      if (cut && has) {
        inp.setRangeText('', s, e, 'end');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    if (!sel) return;
    const tsv = selectionTSV();
    if (tsv && cbs.clip) cbs.clip(tsv);
    if (cut) clearSelection();
  };

  window.__tdPaste = (text) => {
    if (editing && editInput) {
      editInput.setRangeText(String(text || ''),
        editInput.selectionStart, editInput.selectionEnd, 'end');
      return;
    }
    // any other focused text input: paste at the caret / over the selection
    const inp = focusedInput();
    if (inp) {
      if (inp.setRangeText && inp.selectionStart != null) {
        inp.setRangeText(String(text || ''),
          inp.selectionStart, inp.selectionEnd, 'end');
      } else {
        inp.value += String(text || '');
      }
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    pasteTSV(String(text || ''));
  };

  // in-TD cursor pipe: offscreen CEF can't change the OS cursor, so the
  // page reports the CSS cursor under the pointer and the ext maps it
  // onto the container COMP's cursor par. Gated on __inTD (set by the
  // ext's webrender kick) so external browsers never drive the panel.
  let lastCursor = '';
  document.addEventListener('pointermove', (e) => {
    if (!window.__inTD || !cbs.cursor || !(e.target instanceof Element)) return;
    const cur = getComputedStyle(e.target).cursor || 'default';
    if (cur === lastCursor) return;
    lastCursor = cur;
    cbs.cursor(cur);
  });

  // shift+wheel in-TD: interactMouse wheel is vertical-only, so the ext
  // injects horizontal scrolls here (external browsers do it natively)
  window.__tdHWheel = (notches) => {
    if (body) body.scrollLeft -= notches * 120;
  };

  // ---- context menu ------------------------------------------------------------------------

  function closeCtx() {
    if (ctxEl) { ctxEl.remove(); ctxEl = null; }
  }

  function showCtx(x, y, items) {
    closeCtx();
    ctxEl = document.createElement('div');
    ctxEl.id = 'ctxmenu';
    for (const it of items) {
      if (it === '-') {
        const sep = document.createElement('div');
        sep.className = 'sep';
        ctxEl.appendChild(sep);
        continue;
      }
      const d = document.createElement('div');
      d.className = 'item' + (it.disabled ? ' disabled' : '');
      d.textContent = it.label;
      d.addEventListener('pointerdown', (e) => {
        // preventDefault: a trusted mousedown's default action moves
        // focus to body AFTER this handler — that blurred (and killed)
        // the rename input the instant it opened
        e.preventDefault();
        e.stopPropagation();
        if (it.disabled) return;
        closeCtx();
        it.fn();
      });
      ctxEl.appendChild(d);
    }
    document.body.appendChild(ctxEl);
    const r = ctxEl.getBoundingClientRect();
    ctxEl.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
    ctxEl.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
  }

  function cellCtxItems() {
    const s = normSel();
    const rows = selDatRows();
    const nr = rows.length || 1;
    const cols = s ? Array.from({ length: s.c1 - s.c0 + 1 }, (_, i) => s.c0 + i) : [];
    const ro = !T || !T.editable;
    const at = rows.length ? rows[0] : T.cells.length;
    const blank = (n) => Array.from({ length: n }, () => []);
    const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
    return [
      { label: `Insert ${plural(nr, 'row')} above`, disabled: ro,
        fn: () => structOp(() => cbs.insertRows(at, blank(nr)),
          `insert ${plural(nr, 'row')}`) },
      { label: `Insert ${plural(nr, 'row')} below`, disabled: ro,
        fn: () => structOp(() => cbs.insertRows((rows.length ? rows[rows.length - 1] : T.cells.length - 1) + 1, blank(nr)),
          `insert ${plural(nr, 'row')}`) },
      { label: `Delete ${plural(nr, 'row')}`, disabled: ro || !rows.length,
        fn: () => structOp(() => cbs.deleteRows(rows),
          `delete ${plural(nr, 'row')}`) },
      '-',
      { label: `Insert ${plural(cols.length, 'column')} left`,
        disabled: ro || !cols.length,
        fn: () => structOp(() => cbs.insertCols(cols[0], cols.length),
          `insert ${plural(cols.length, 'column')}`) },
      { label: `Insert ${plural(cols.length, 'column')} right`,
        disabled: ro || !cols.length,
        fn: () => structOp(() => cbs.insertCols(cols[cols.length - 1] + 1, cols.length),
          `insert ${plural(cols.length, 'column')}`) },
      { label: `Delete ${plural(cols.length, 'column')}`,
        disabled: ro || !cols.length || cols.length >= numCols(),
        fn: () => structOp(() => cbs.deleteCols(cols),
          `delete ${plural(cols.length, 'column')}`) },
      '-',
      { label: 'Clear cells', disabled: ro || !s, fn: clearSelection },
      { label: 'Apply sort to DAT', disabled: ro || sortDir === 0 || !!filterStr,
        fn: applySortToDAT },
    ];
  }

  // gutter right-click: row menu + clipboard-row insertion at that index
  function gutterCtxItems(vr) {
    const ro = !T || !T.editable;
    const items = cellCtxItems();
    items.push('-', {
      label: 'Insert clipboard rows here',
      disabled: ro || !cbs.getClip,
      fn: () => cbs.getClip((text) => {
        const t = String(text || '');
        if (!t.trim()) return;
        const rows = t.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
          .map((l) => l.split('\t'));
        if (!rows.length) return;
        structOp(() => cbs.insertRows(datR(vr), rows),
          `insert ${rows.length} clipboard row${rows.length > 1 ? 's' : ''}`);
        if (viewReorderable()) {       // highlight the landed block
          sel = { ar: vr, ac: 0, er: vr + rows.length - 1,
            ec: numCols() - 1, rowMode: true };
          extraSels = [];
          render();
        }
      }),
    });
    return items;
  }

  // ---- pointer interactions -------------------------------------------------------------------

  // inactive pointer ids (synthetic events, racing releases) throw
  function capture(elm, e) {
    try { elm.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
  }

  // In-TD pointer events come from interactMouse, which carries no
  // modifier flags — the ext tracks them from keyboardin and pushes
  // window.__tdMods; merge it with the event's own flags (browsers).
  function evMods(e) {
    const m = window.__tdMods || {};
    return {
      ctrl: e.ctrlKey || !!m.ctrl,
      meta: e.metaKey || !!m.cmd,
      shift: e.shiftKey || !!m.shift,
    };
  }

  function cellFromEvent(e) {
    const rect = body.getBoundingClientRect();
    const x = e.clientX - rect.left + body.scrollLeft;
    const y = e.clientY - rect.top + body.scrollTop;
    const vr = Math.floor(y / ROWH);
    if (vr < 0 || vr >= viewRows.length || x > totalW()) return null;
    return { vr, c: colAt(x) };
  }

  function bindBody() {
    body.addEventListener('pointerdown', (e) => {
      closeCtx();
      if (editing) commitEdit(0, 0);
      const hit = cellFromEvent(e);
      if (!hit) { clip.focus({ preventScroll: true }); return; }
      e.preventDefault();
      clip.focus({ preventScroll: true });
      if (e.button === 2) {
        const s = normSel();
        const inside = s && hit.vr >= s.r0 && hit.vr <= s.r1
          && hit.c >= s.c0 && hit.c <= s.c1;
        if (!inside) setAnchor(hit.vr, hit.c, false);
        showCtx(e.clientX, e.clientY, cellCtxItems());
        return;
      }
      if (e.button !== 0) return;
      const mods = evMods(e);
      const multi = (mods.ctrl || mods.meta) && !mods.shift;
      if (isVirt(hit.c)) {
        // virtual cells never select or edit; a plain click fires the
        // callback (and runs the built-in action for `delete` mode)
        if (!mods.shift && !multi) clickCell(hit.vr, hit.c, e.target);
        return;
      }
      // universal Lister-style onClick: every plain left-click on a real,
      // non-button cell reaches the generic onClick — alongside, never
      // instead of, selection/edit. Button cells go through {t:button}.
      if (!mods.shift && !multi && effFmt(hit.c) !== 'button' && cbs.click) {
        cbs.click(datR(hit.vr), hit.c, colName(hit.c));
      }
      if (effFmt(hit.c) === 'checkbox' && T.editable && effEditable(hit.c)
          && !mods.shift && !multi) {
        // checkbox cells toggle on a plain click — no edit mode
        setAnchor(hit.vr, hit.c, false);
        toggleCheckbox(hit.vr, hit.c);
        return;
      }
      if (effFmt(hit.c) === 'button' && !mods.shift && !multi) {
        // button cells fire the click callback — no selection change, no
        // edit; works on read-only tables (buttons read)
        clickCell(hit.vr, hit.c, e.target);
        return;
      }
      const now = Date.now();
      if (!mods.shift && !multi && hit.vr === lastPress.vr && hit.c === lastPress.c
          && now - lastPress.t < 400) {
        lastPress = { vr: -1, c: -1, t: 0 };
        startEdit(hit.vr, hit.c);
        return;
      }
      lastPress = { vr: hit.vr, c: hit.c, t: now };
      if (multi && sel) {
        // ctrl/cmd: keep the current rect, start a new active one here
        extraSels.push({ ...sel });
        sel = { ar: hit.vr, ac: hit.c, er: hit.vr, ec: hit.c };
        scrollTo(hit.vr, hit.c);
        render();
      } else {
        setAnchor(hit.vr, hit.c, mods.shift);
      }
      capture(body, e);
      const onMove = (ev) => {
        const h = cellFromEvent(ev);
        if (h) h.c = Math.min(h.c, numCols() - 1);   // never into virtuals
        if (h && sel && (h.vr !== sel.er || h.c !== sel.ec)) {
          sel.er = h.vr;
          sel.ec = h.c;
          scrollTo(h.vr, h.c);
          render();
        }
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    body.addEventListener('dblclick', (e) => {
      const hit = cellFromEvent(e);
      // checkbox toggles and buttons fire on single click — no editor
      if (hit && (effFmt(hit.c) === 'checkbox' || effFmt(hit.c) === 'button'
          || isVirt(hit.c))) return;
      if (hit) startEdit(hit.vr, hit.c);
    });

    body.addEventListener('contextmenu', (e) => e.preventDefault());

    body.addEventListener('scroll', () => {
      colheadInner.style.transform = `translateX(${-body.scrollLeft}px)`;
      gutterInner.style.transform = `translateY(${-body.scrollTop}px)`;
      requestRender();
    });
  }

  function bindGutter() {
    const gutter = gutterInner.parentElement;
    gutter.addEventListener('contextmenu', (e) => e.preventDefault());
    gutter.addEventListener('pointerdown', (e) => {
      closeCtx();
      if (editing) commitEdit(0, 0);
      const g = e.target.closest('.gcell');
      if (!g) return;
      e.preventDefault();
      clip.focus({ preventScroll: true });
      const vr = +g.dataset.vr;
      const inSel = allRects().some((r) =>
        vr >= r.r0 && vr <= r.r1 && fullWidth(r));
      if (e.button === 2) {
        if (!inSel) selectRow(vr, false);
        showCtx(e.clientX, e.clientY, gutterCtxItems(vr));
        return;
      }
      if (e.button !== 0) return;
      const mods = evMods(e);
      if ((mods.ctrl || mods.meta) && !mods.shift) {
        // ctrl/cmd toggles the row in/out of a non-contiguous row set
        // (flattens any cell rects to whole rows — gutter = row domain)
        const rows = new Set();
        for (const r of allRects()) {
          for (let v = r.r0; v <= Math.min(r.r1, viewRows.length - 1); v++) rows.add(v);
        }
        if (rows.has(vr)) rows.delete(vr); else rows.add(vr);
        const rects = [];
        for (const v of [...rows].sort((a, b) => a - b)) {
          const last = rects[rects.length - 1];
          if (last && last.er === v - 1) last.er = v;
          else rects.push({ ar: v, ac: 0, er: v, ec: numCols() - 1 });
        }
        sel = rects.pop() || null;
        if (sel) sel.rowMode = true;
        extraSels = rects;
        render();
        return;
      }
      // modifier-free gutter gestures still work (drag on an unselected
      // row range-selects, drag on a selected row reorders); modifiers
      // come from the event in browsers and from __tdMods in-TD.
      let mode = 'select';
      if (mods.shift && sel) {
        sel.er = vr;
        sel.ac = 0;
        sel.ec = numCols() - 1;
        render();
        return;                  // extend only — no drag from a shift-click
      }
      if (inSel && viewReorderable()) {
        mode = 'reorder';
      } else {
        selectRow(vr, false);
      }
      const startY = e.clientY;
      let armed = false;
      let gap = -1;
      const vrFromY = (ev) => {
        const rect = body.getBoundingClientRect();
        return (ev.clientY - rect.top + body.scrollTop) / ROWH;
      };
      const onMove = (ev) => {
        if (!armed && Math.abs(ev.clientY - startY) < 5) return;
        armed = true;
        if (mode === 'select') {
          const tvr = Math.max(0, Math.min(Math.floor(vrFromY(ev)), viewRows.length - 1));
          if (sel && sel.er !== tvr) {
            sel.er = tvr;
            scrollTo(tvr, 0);
            render();
          }
          return;
        }
        gap = Math.max(0, Math.min(Math.round(vrFromY(ev)), viewRows.length));
        dropline.style.top = (gap * ROWH - 1) + 'px';
        dropline.style.width = totalW() + 'px';
        dropline.hidden = false;
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        dropline.hidden = true;
        if (mode !== 'reorder' || !armed || gap < 0) return;
        const rows = selDatRows();
        const to = gap < viewRows.length ? datR(gap) : T.cells.length;
        structOp(() => cbs.moveRows(rows, to),
          `move ${rows.length} row${rows.length > 1 ? 's' : ''}`);
        // selection follows the dropped block (view == DAT order here)
        const selViews = rows.map((dr) => dr - headOff());
        const newStart = gap - selViews.filter((v) => v < gap).length;
        sel = { ar: newStart, ac: 0,
          er: newStart + rows.length - 1, ec: numCols() - 1, rowMode: true };
        extraSels = [];
        render();
      };
      capture(gutter, e);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  // explicit "write the view's sort order into the DAT" op (header menu,
  // cell menu, toolbar button) — view sort itself never mutates the table
  function applySortToDAT() {
    if (!T || !T.editable || sortDir === 0 || filterStr) return;
    structOp(() => cbs.applySort(viewRows.slice()), 'apply sort to DAT');
    sortDir = 0;
    sortCol = -1;       // the reordered table broadcast follows
    renderAll();
  }

  function selectColumn(c) {
    if (!viewRows.length) return;
    sel = { ar: 0, ac: c, er: viewRows.length - 1, ec: c };
    extraSels = [];
    render();
  }

  // write a property change for a DAT-backed column into the colDefine
  // (creates the entry on first touch — the menu IS the config editor)
  function setSrcDef(c, set) {
    if (!cbs.setColDef) return;
    const name = srcOver[c] ? srcOver[c].name : colName(c);
    cbs.setColDef([{ column: name, set: { source: colName(c), ...set } }]);
  }

  // graduate the ad-hoc localStorage view (formats/hidden/widths) into a
  // project-portable colDefine — one entry per DAT column
  function saveViewAsConfig() {
    if (!cbs.setColDef || !T) return;
    const defs = [];
    for (let c = 0; c < numCols(); c++) {
      defs.push({ column: colName(c), set: {
        source: colName(c),
        mode: colFmt[c] || 'text',
        visible: colHide[c] ? 0 : 1,
        width: Math.round(colW[c] || 0) || '',
      } });
    }
    cbs.setColDef(defs);
    log('saved view as colDefine config');
  }

  // "Column settings…" wizard: in-page form that edits one colDefine
  // entry — no docs trip. c = DAT column, virtual column, or -1 (new).
  let wizEl = null;
  function colSettings(c) {
    closeWiz();
    const isNew = c < 0;
    const d = isNew ? null : (isVirt(c) ? vDef(c) : srcOver[c]);
    const cur = {
      column: d ? d.name : (isNew ? '' : colName(c)),
      label: d ? d.label : (isNew ? '' : colName(c)),
      source: !isNew && !isVirt(c) ? colName(c)
        : (d && d.src >= 0 ? colName(d.src) : ''),
      mode: d ? d.mode : (isNew ? 'button' : effFmt(c)),
      expr: d ? d.expr : '',
      icon: d ? d.icon : '',
      visible: d ? d.visible : !(!isNew && colHide[c]),
      editable: d ? d.editable : true,
      width: d && d.width ? d.width : '',
    };
    wizEl = document.createElement('div');
    wizEl.id = 'colwizard';
    const srcOpts = ['<option value="">(none — UI-only column)</option>'];
    for (let i = 0; i < numCols(); i++) {
      const n = colName(i);
      srcOpts.push(`<option value="${n}"${n === cur.source ? ' selected' : ''}>${n}</option>`);
    }
    const modeOpts = ['text', 'checkbox', 'button', 'thumb', 'delete', 'eval']
      .map((m) => `<option value="${m}"${m === cur.mode ? ' selected' : ''}>${m}</option>`);
    wizEl.innerHTML = `
      <div class="wizhead">
        <div class="wizttl">${isNew ? 'Add UI column' : 'Column settings'}</div>
        <button id="wz-close" class="wizclose" title="Close" aria-label="Close">×</button>
      </div>
      <div class="wizbody">
        <label>Column name <input id="wz-column" value="${cur.column}"></label>
        <label>Label <input id="wz-label" value="${cur.label}"></label>
        <label>Source column <select id="wz-source">${srcOpts.join('')}</select></label>
        <label>Format <select id="wz-mode">${modeOpts.join('')}</select></label>
        <label>Expression <input id="wz-expr" value="${cur.expr.replace(/"/g, '&quot;')}"
          placeholder="f&quot;{cells['path']}/out1&quot; — python, per row"></label>
        <label>Button icon <input id="wz-icon" value="${cur.icon}"
          placeholder="TOP path or image file"></label>
        <label>Width <input id="wz-width" value="${cur.width}" placeholder="auto"></label>
        <label class="wizrow"><input type="checkbox" id="wz-visible"${cur.visible ? ' checked' : ''}> visible</label>
        <label class="wizrow"><input type="checkbox" id="wz-editable"${cur.editable ? ' checked' : ''}> editable</label>
      </div>
      <div class="wizbtns">
        <button id="wz-save">Save</button>
        <button id="wz-cancel">Cancel</button>
      </div>`;
    el.appendChild(wizEl);
    const save = () => {
      const name = wizEl.querySelector('#wz-column').value.trim();
      if (!name) { closeWiz(); return; }
      const set = {
        label: wizEl.querySelector('#wz-label').value.trim(),
        source: wizEl.querySelector('#wz-source').value,
        mode: wizEl.querySelector('#wz-mode').value,
        expr: wizEl.querySelector('#wz-expr').value.trim(),
        icon: wizEl.querySelector('#wz-icon').value.trim(),
        width: wizEl.querySelector('#wz-width').value.trim(),
        visible: wizEl.querySelector('#wz-visible').checked ? 1 : 0,
        editable: wizEl.querySelector('#wz-editable').checked ? 1 : 0,
      };
      const defs = [{ column: name, set }];
      if (d && d.name !== name) defs.unshift({ column: d.name });   // rename
      if (cbs.setColDef) cbs.setColDef(defs);
      closeWiz();
    };
    wizEl.querySelector('#wz-save').addEventListener('click', save);
    wizEl.querySelector('#wz-cancel').addEventListener('click', closeWiz);
    wizEl.querySelector('#wz-close').addEventListener('click', closeWiz);
    wizEl.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); save(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); closeWiz(); }
      else if (ev.key === 'Tab') {
        // cycle within the dialog (so Tab past the last field doesn't blur
        // out and close it) — mirrors the in-TD __tdKey path
        ev.preventDefault();
        tabWithin(wizEl, document.activeElement, ev.shiftKey);
      }
    });
    wizEl.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    // Close once focus leaves the wizard entirely (it has to gain focus
    // first — we focus #wz-column below). Defer so the new focus target
    // settles before we test containment (focusout fires before focusin).
    wizEl.addEventListener('focusout', () => {
      setTimeout(() => {
        if (wizEl && !wizEl.contains(document.activeElement)) closeWiz();
      }, 0);
    });
    wizEl.querySelector('#wz-column').focus();
  }

  function closeWiz() {
    if (wizEl) { wizEl.remove(); wizEl = null; }
    clip.focus({ preventScroll: true });
  }

  // header right-click rename: inline input over the header cell, commits
  // a plain {r:0,c} edit (header row is DAT row 0)
  let headEdit = null;
  function renameColumn(c) {
    if (!T || !T.editable || !T.headerRow) return;
    if (headEdit) headEdit.remove();
    const inp = document.createElement('input');
    inp.id = 'headedit';
    inp.value = val(0, c);
    inp.style.position = 'absolute';
    inp.style.left = colLeft(c) + 'px';
    inp.style.top = '0';
    inp.style.width = eW[c] + 'px';
    inp.style.height = '100%';
    headEdit = inp;
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const v = inp.value;
      inp.remove();
      headEdit = null;
      clip.focus({ preventScroll: true });
      if (commit && v !== val(0, c)) {
        localEdit([{ r: 0, c, v }], `rename column ${c} → "${v}"`);
      }
    };
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    colheadInner.appendChild(inp);
    inp.focus();
    inp.select();
  }

  function selectRow(vr, extend) {
    if (!numCols()) return;
    if (extend && sel) { sel.er = vr; }
    else { sel = { ar: vr, ac: 0, er: vr, ec: numCols() - 1 }; extraSels = []; }
    sel.ac = 0;
    sel.ec = numCols() - 1;
    sel.rowMode = true;
    render();
  }

  function bindHead() {
    const colhead = colheadInner.parentElement;
    colhead.addEventListener('contextmenu', (e) => e.preventDefault());
    colhead.addEventListener('pointerdown', (e) => {
      closeCtx();
      if (editing) commitEdit(0, 0);
      const rz = e.target.closest('.hresize');
      if (rz) {
        e.preventDefault();
        const c = +rz.dataset.c;
        const startX = e.clientX;
        const startW = eW[c];   // what the user sees (incl. fill stretch)
        const onMove = (ev) => {
          colW[c] = Math.max(MINW, startW + ev.clientX - startX);
          updateEff();
          renderHead();
          render();
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          persistColW(c);
        };
        capture(colhead, e);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        return;
      }
      const h = e.target.closest('.hcell');
      if (!h) return;
      e.preventDefault();
      clip.focus({ preventScroll: true });
      const c = +h.dataset.c;
      if (isVirt(c)) {
        if (e.button === 2) {
          showCtx(e.clientX, e.clientY, [
            { label: 'Column settings…', fn: () => colSettings(c) },
            { label: 'Delete UI column', fn: () => {
              const d = vDef(c);
              if (d && cbs.setColDef) cbs.setColDef([{ column: d.name }]);
            } },
          ]);
        }
        return;   // virtual headers don't sort or drag-reorder
      }
      if (e.button === 2) {
        const ro = !T || !T.editable;
        showCtx(e.clientX, e.clientY, [
          { label: 'Sort ascending', fn: () => { sortCol = c; sortDir = 1; renderAll(); } },
          { label: 'Sort descending', fn: () => { sortCol = c; sortDir = -1; renderAll(); } },
          { label: 'Clear sort', disabled: sortDir === 0,
            fn: () => { sortDir = 0; sortCol = -1; renderAll(); } },
          { label: 'Apply sort to DAT', disabled: ro || sortDir === 0 || !!filterStr,
            fn: applySortToDAT },
          '-',
          { label: 'Rename column', disabled: ro || !T || !T.headerRow,
            fn: () => renameColumn(c) },
          { label: 'Select column contents', disabled: !viewRows.length,
            fn: () => selectColumn(c) },
          '-',
          ...['text', 'checkbox', 'button', 'thumb'].map((f) => ({
            label: (effFmt(c) === f ? '✓ ' : ' ')
              + 'Format: ' + (f === 'thumb' ? 'thumbnail' : f),
            fn: () => {
              if (configured() || srcOver[c]) {
                setSrcDef(c, { mode: f });
              } else {
                if (f === 'text') delete colFmt[c]; else colFmt[c] = f;
                saveFmt();
                render();
              }
            },
          })),
          { label: 'Column settings…', fn: () => colSettings(c) },
          { label: 'Add UI column…', fn: () => colSettings(-1) },
          '-',
          { label: 'Hide column', disabled: hiddenCount() >= numCols() - 1,
            fn: () => {
              if (configured() || srcOver[c]) {
                setSrcDef(c, { visible: 0 });
              } else {
                colHide[c] = true;
                saveFmt();
                renderAll();
              }
            } },
          { label: `Show ${hiddenCount()} hidden column${hiddenCount() > 1 ? 's' : ''}`,
            disabled: !hiddenCount(),
            fn: () => {
              colHide = {};
              saveFmt();
              if (configured() && cbs.setColDef) {
                const defs = [];
                for (let i = 0; i < numCols(); i++) {
                  if (srcOver[i] && !srcOver[i].visible) {
                    defs.push({ column: srcOver[i].name, set: { visible: 1 } });
                  }
                }
                if (defs.length) cbs.setColDef(defs);
              }
              renderAll();
            } },
          { label: 'Save view as config', disabled: configured(),
            fn: saveViewAsConfig },
          '-',
          { label: 'Insert column left', disabled: ro, fn: () => structOp(() => cbs.insertCols(c, 1), 'insert column') },
          { label: 'Insert column right', disabled: ro, fn: () => structOp(() => cbs.insertCols(c + 1, 1), 'insert column') },
          { label: 'Delete column', disabled: ro || numCols() < 2,
            fn: () => structOp(() => cbs.deleteCols([c]), 'delete column') },
        ]);
        return;
      }
      if (e.button !== 0) return;
      // drag reorders the column (writes the DAT); plain click cycles the
      // view-only sort asc -> desc -> off on release
      const startX = e.clientX;
      let dragging = false;
      let gap = -1;
      const onMove = (ev) => {
        if (!dragging && Math.abs(ev.clientX - startX) < 6) return;
        if (!T || !T.editable) return;
        dragging = true;
        const bodyRect = body.getBoundingClientRect();
        const x = ev.clientX - bodyRect.left + body.scrollLeft;
        const cc = colAt(Math.max(0, Math.min(x, totalW() - 1)));
        gap = x > colLeft(cc) + eW[cc] / 2 ? cc + 1 : cc;
        const gridRect = el.getBoundingClientRect();
        colDrop.style.left =
          (bodyRect.left - gridRect.left + colLeft(gap) - body.scrollLeft - 1) + 'px';
        colDrop.hidden = false;
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        colDrop.hidden = true;
        if (dragging) {
          if (gap >= 0 && gap !== c && gap !== c + 1) {
            // keep the resized widths and formats attached to their columns
            const w = colW.splice(c, 1)[0];
            colW.splice(gap - (c < gap ? 1 : 0), 0, w);
            saveColW();
            moveFmt(c, gap);
            saveFmt();
            structOp(() => cbs.moveCols([c], gap), 'move column');
          }
          return;
        }
        if (sortCol !== c || sortDir === 0) { sortCol = c; sortDir = 1; }
        else if (sortDir === 1) sortDir = -1;
        else { sortDir = 0; sortCol = -1; }
        renderAll();
      };
      capture(colhead, e);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  function bindClipboard() {
    document.addEventListener('copy', (e) => {
      if (editing || !sel || document.activeElement !== clip) return;
      e.clipboardData.setData('text/plain', selectionTSV());
      e.preventDefault();
    });
    document.addEventListener('cut', (e) => {
      if (editing || !sel || document.activeElement !== clip) return;
      e.clipboardData.setData('text/plain', selectionTSV());
      e.preventDefault();
      clearSelection();
    });
    document.addEventListener('paste', (e) => {
      if (editing || document.activeElement !== clip) return;
      const text = e.clipboardData.getData('text/plain');
      if (text) { pasteTSV(text); e.preventDefault(); }
    });
  }

  // ---- public api -----------------------------------------------------------------------------

  function init(rootEl, callbacks) {
    el = rootEl;
    cbs = callbacks;
    el.innerHTML = `
      <div id="corner"></div>
      <div id="colhead"><div id="colheadinner"></div></div>
      <div id="gutter"><div id="gutterinner"></div></div>
      <div id="body"><div id="spacer">
        <div id="rows"></div>
        <div id="dropline" hidden></div>
      </div></div>
      <div id="coldropline" hidden></div>
      <div id="emptystate">NO TARGET TABLE</div>
      <textarea id="clip" tabindex="-1" autocomplete="off"></textarea>`;
    body = el.querySelector('#body');
    spacer = el.querySelector('#spacer');
    rowsEl = el.querySelector('#rows');
    colheadInner = el.querySelector('#colheadinner');
    gutterInner = el.querySelector('#gutterinner');
    emptyEl = el.querySelector('#emptystate');
    dropline = el.querySelector('#dropline');
    colDrop = el.querySelector('#coldropline');
    clip = el.querySelector('#clip');
    clip.addEventListener('keydown', (e) => { if (!editing) handleKey(e); });
    // capture phase: runs BEFORE the handler that may open a menu on this
    // same event — otherwise the opening pointerdown bubbles up here and
    // closes the menu in the same tick
    document.addEventListener('pointerdown', (e) => {
      if (ctxEl && !ctxEl.contains(e.target)) closeCtx();
    }, true);
    window.addEventListener('resize', () => {
      updateEff();           // re-stretch the fill column to the new panel
      renderHead();
      requestRender();
    });
    bindBody();
    bindGutter();
    bindHead();
    bindClipboard();
    clip.focus({ preventScroll: true });
  }

  function setFilter(s) {
    filterStr = String(s || '');
    renderAll();
  }

  function dims() {
    return T ? { rows: T.cells.length, cols: numCols(), editable: T.editable } : null;
  }

  // row height must stay in sync with the --rowh CSS var (virtualization
  // math); called by main.js when a {t:style} broadcast lands
  function setStyle(s) {
    if (s && typeof s.rowh === 'number' && s.rowh > 0) ROWH = s.rowh;
    if (T) renderAll();
  }

  // toolbar entry points (routed through the grid for undo coverage)
  function appendRow() {
    if (T && T.editable) structOp(() => cbs.insertRows(T.cells.length, [[]]), 'append row');
  }

  function appendCol() {
    if (T && T.editable) structOp(() => cbs.insertCols(numCols(), 1), 'append column');
  }

  return { init, setTable, applyEdits, setFilter, dims, setStyle,
    appendRow, appendCol, applySortToDAT, setUiVals, resetView };
})();
