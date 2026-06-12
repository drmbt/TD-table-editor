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
  const ROWH = 26;
  const DEFW = 110;
  const MINW = 40;
  const OVERSCAN = 6;
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  let el, cbs;
  let body, spacer, rowsEl, colheadInner, gutterInner, emptyEl, clip;
  let editInput = null;
  let dropline = null;
  let ctxEl = null;

  let T = null;            // {path,name,editable,headerRow,cells}
  let colW = [];
  let sortCol = -1;
  let sortDir = 0;         // 0 none, 1 asc, -1 desc
  let filterStr = '';
  let viewRows = [];       // DAT row indices, header excluded
  let sel = null;          // {ar,ac,er,ec} in view coords (anchor + extent)
  let editing = null;      // {vr,c}
  let renderQueued = false;

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
  const totalW = () => colW.reduce((a, b) => a + b, 0);
  const colLeft = (c) => colW.slice(0, c).reduce((a, b) => a + b, 0);
  const colAt = (x) => {
    let acc = 0;
    for (let c = 0; c < colW.length; c++) {
      acc += colW[c];
      if (x < acc) return c;
    }
    return colW.length - 1;
  };
  const normSel = () => sel && {
    r0: Math.min(sel.ar, sel.er), r1: Math.max(sel.ar, sel.er),
    c0: Math.min(sel.ac, sel.ec), c1: Math.max(sel.ac, sel.ec),
  };
  const viewReorderable = () => T && T.editable && sortDir === 0 && !filterStr;

  // selected DAT rows (whole-row ops use the selection's row span)
  function selDatRows() {
    const s = normSel();
    if (!s) return [];
    const rows = [];
    for (let vr = s.r0; vr <= Math.min(s.r1, viewRows.length - 1); vr++) {
      rows.push(datR(vr));
    }
    return rows;
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
    if (!sel) return;
    const maxR = viewRows.length - 1;
    const maxC = numCols() - 1;
    if (maxR < 0 || maxC < 0) { sel = null; return; }
    for (const k of ['ar', 'er']) sel[k] = Math.max(0, Math.min(sel[k], maxR));
    for (const k of ['ac', 'ec']) sel[k] = Math.max(0, Math.min(sel[k], maxC));
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
    for (let c = 0; c < numCols(); c++) {
      const h = document.createElement('div');
      h.className = 'hcell';
      h.style.width = colW[c] + 'px';
      h.dataset.c = c;
      h.textContent = T.headerRow ? (val(0, c) || colLetter(c)) : colLetter(c);
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
    const s = normSel();

    const frag = document.createDocumentFragment();
    const gfrag = document.createDocumentFragment();
    for (let vr = first; vr <= last; vr++) {
      const r = datR(vr);
      const row = document.createElement('div');
      row.className = 'vrow' + (vr % 2 ? ' alt' : '');
      row.style.top = (vr * ROWH) + 'px';
      for (let c = 0; c < numCols(); c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.style.width = colW[c] + 'px';
        cell.dataset.vr = vr;
        cell.dataset.c = c;
        cell.textContent = val(r, c);
        if (s && vr >= s.r0 && vr <= s.r1 && c >= s.c0 && c <= s.c1) {
          cell.classList.add('sel');
        }
        if (sel && vr === sel.ar && c === sel.ac) cell.classList.add('cur');
        row.appendChild(cell);
      }
      frag.appendChild(row);

      const g = document.createElement('div');
      g.className = 'gcell';
      g.style.top = (vr * ROWH) + 'px';
      g.dataset.vr = vr;
      g.textContent = r;                     // DAT row index, on purpose
      if (s && vr >= s.r0 && vr <= s.r1) g.classList.add('sel');
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
    if (s) {
      const nr = s.r1 - s.r0 + 1;
      const nc = s.c1 - s.c0 + 1;
      selInfo = nr * nc > 1 ? `${nr}×${nc} selected`
        : `r${datR(sel.ar)} c${sel.ac}`;
    }
    cbs.status({ dims, sel: selInfo });
  }

  // ---- table data in/out ----------------------------------------------------------

  function loadColW() {
    const n = numCols();
    let w = null;
    try {
      w = JSON.parse(localStorage.getItem('tdtable:' + T.path + ':colw'));
    } catch (e) { /* fresh */ }
    colW = Array.from({ length: n }, (_, i) =>
      (w && typeof w[i] === 'number' ? Math.max(MINW, w[i]) : DEFW));
  }

  function saveColW() {
    try {
      localStorage.setItem('tdtable:' + T.path + ':colw', JSON.stringify(colW));
    } catch (e) { /* private mode etc. */ }
  }

  function setTable(t) {
    const samePath = T && T.path === t.path;
    cancelEdit();
    T = t;
    if (!samePath || colW.length !== numCols()) loadColW();
    if (!samePath) { sortCol = -1; sortDir = 0; sel = null; body.scrollTop = 0; }
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

  function localEdit(edits) {
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

  // ---- selection & navigation --------------------------------------------------

  function setAnchor(vr, c, extend) {
    vr = Math.max(0, Math.min(vr, viewRows.length - 1));
    c = Math.max(0, Math.min(c, numCols() - 1));
    if (extend && sel) { sel.er = vr; sel.ec = c; }
    else sel = { ar: vr, ac: c, er: vr, ec: c };
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
    else if (left + colW[c] > body.scrollLeft + body.clientWidth) {
      body.scrollLeft = left + colW[c] - body.clientWidth;
    }
  }

  function move(dr, dc, extend) {
    if (!sel) { setAnchor(0, 0, false); return; }
    const fr = extend ? sel.er : sel.ar;
    const fc = extend ? sel.ec : sel.ac;
    setAnchor(fr + dr, fc + dc, extend);
  }

  // ---- editing -------------------------------------------------------------------

  function startEdit(vr, c, initial) {
    if (!T || !T.editable || vr < 0 || vr >= viewRows.length) return;
    cancelEdit();
    editing = { vr, c };
    editInput = document.createElement('input');
    editInput.id = 'celledit';
    editInput.value = initial !== undefined ? initial : val(datR(vr), c);
    editInput.style.top = (vr * ROWH) + 'px';
    editInput.style.left = colLeft(c) + 'px';
    editInput.style.width = colW[c] + 'px';
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
    if (v !== val(datR(vr), c)) localEdit([{ r: datR(vr), c, v }]);
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

  function clearSelection() {
    if (!T || !T.editable) return;
    const s = normSel();
    if (!s) return;
    const edits = [];
    for (let vr = s.r0; vr <= s.r1; vr++) {
      for (let c = s.c0; c <= s.c1; c++) {
        if (val(datR(vr), c) !== '') edits.push({ r: datR(vr), c, v: '' });
      }
    }
    if (edits.length) localEdit(edits);
  }

  // ---- clipboard --------------------------------------------------------------------

  function selectionTSV() {
    const s = normSel();
    if (!s) return '';
    const lines = [];
    for (let vr = s.r0; vr <= s.r1; vr++) {
      const cells = [];
      for (let c = s.c0; c <= s.c1; c++) cells.push(val(datR(vr), c));
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
          edits.push({ r: datR(vr), c, v: rows[0][0] });
        }
      }
    } else {
      for (let i = 0; i < rows.length; i++) {
        const vr = s.r0 + i;
        if (vr >= viewRows.length) break;       // grow-on-paste is M3
        for (let j = 0; j < rows[i].length; j++) {
          const c = s.c0 + j;
          if (c >= numCols()) break;
          edits.push({ r: datR(vr), c, v: rows[i][j] });
        }
      }
      sel.er = Math.min(s.r0 + rows.length - 1, viewRows.length - 1);
      sel.ec = Math.min(s.c0 + rows[0].length - 1, numCols() - 1);
    }
    if (edits.length) localEdit(edits);
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
      render();
    } else if (!meta && k.length === 1 && sel && T.editable) {
      startEdit(sel.ar, sel.ac, k);
      e.preventDefault();
    }
  }

  // TD in-panel keystrokes arrive via executeJavaScript (webrenderTOP has no
  // native key injection). Map TD's lowercase short names onto handleKey /
  // the live editor.
  const TD_KEYS = {
    enter: 'Enter', esc: 'Escape', tab: 'Tab', backspace: 'Backspace',
    delete: 'Delete', left: 'ArrowLeft', right: 'ArrowRight',
    up: 'ArrowUp', down: 'ArrowDown', home: 'Home', end: 'End',
    pgup: 'PageUp', pgdn: 'PageDown',
  };

  window.__tdKey = (k) => {
    if (editing && editInput) {
      if (k.key === 'enter') { commitEdit(1, 0); return; }
      if (k.key === 'tab') { commitEdit(0, 1); return; }
      if (k.key === 'esc') { cancelEdit(); return; }
      if (k.key === 'backspace') {
        editInput.value = editInput.value.slice(0, -1);
        return;
      }
      if (k.ch) editInput.value += k.ch;
      return;
    }
    const key = TD_KEYS[k.key] || (k.ch && k.ch.length === 1 ? k.ch : null);
    if (key === null) return;
    handleKey({
      key, shiftKey: !!k.shift, ctrlKey: false, metaKey: false,
      preventDefault: () => {},
    });
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
        e.stopPropagation();
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
    return [
      { label: `Insert ${nr} row${nr > 1 ? 's' : ''} above`, disabled: ro,
        fn: () => cbs.insertRows(at, blank(nr)) },
      { label: `Insert ${nr} row${nr > 1 ? 's' : ''} below`, disabled: ro,
        fn: () => cbs.insertRows((rows.length ? rows[rows.length - 1] : T.cells.length - 1) + 1, blank(nr)) },
      { label: `Delete ${nr} row${nr > 1 ? 's' : ''}`, disabled: ro || !rows.length,
        fn: () => cbs.deleteRows(rows) },
      '-',
      { label: 'Insert column left', disabled: ro || !cols.length,
        fn: () => cbs.insertCols(cols[0], 1) },
      { label: 'Insert column right', disabled: ro || !cols.length,
        fn: () => cbs.insertCols(cols[cols.length - 1] + 1, 1) },
      { label: `Delete ${cols.length} column${cols.length > 1 ? 's' : ''}`,
        disabled: ro || !cols.length || cols.length >= numCols(),
        fn: () => cbs.deleteCols(cols) },
      '-',
      { label: 'Clear cells', disabled: ro || !s, fn: clearSelection },
    ];
  }

  // ---- pointer interactions -------------------------------------------------------------------

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
      setAnchor(hit.vr, hit.c, e.shiftKey);
      body.setPointerCapture(e.pointerId);
      const onMove = (ev) => {
        const h = cellFromEvent(ev);
        if (h && sel && (h.vr !== sel.er || h.c !== sel.ec)) {
          sel.er = h.vr;
          sel.ec = h.c;
          scrollTo(h.vr, h.c);
          render();
        }
      };
      const onUp = () => {
        body.removeEventListener('pointermove', onMove);
        body.removeEventListener('pointerup', onUp);
      };
      body.addEventListener('pointermove', onMove);
      body.addEventListener('pointerup', onUp);
    });

    body.addEventListener('dblclick', (e) => {
      const hit = cellFromEvent(e);
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
      const s = normSel();
      const inSel = s && vr >= s.r0 && vr <= s.r1 && s.c0 === 0
        && s.c1 === numCols() - 1;
      if (e.button === 2) {
        if (!inSel) selectRow(vr, false);
        showCtx(e.clientX, e.clientY, cellCtxItems());
        return;
      }
      if (e.button !== 0) return;
      if (e.shiftKey && sel) { sel.er = vr; sel.ec = numCols() - 1; sel.ac = 0; render(); }
      else if (!inSel) selectRow(vr, false);
      // drag past threshold -> row reorder (when the view matches DAT order)
      if (!viewReorderable()) return;
      const startY = e.clientY;
      let armed = false;
      let gap = -1;
      const onMove = (ev) => {
        if (!armed && Math.abs(ev.clientY - startY) < 5) return;
        armed = true;
        const rect = body.getBoundingClientRect();
        const y = ev.clientY - rect.top + body.scrollTop;
        gap = Math.max(0, Math.min(Math.round(y / ROWH), viewRows.length));
        dropline.style.top = (gap * ROWH - 1) + 'px';
        dropline.style.width = totalW() + 'px';
        dropline.hidden = false;
      };
      const onUp = () => {
        gutter.removeEventListener('pointermove', onMove);
        gutter.removeEventListener('pointerup', onUp);
        dropline.hidden = true;
        if (!armed || gap < 0) return;
        const rows = selDatRows();
        const to = gap < viewRows.length ? datR(gap) : T.cells.length;
        cbs.moveRows(rows, to);
      };
      gutter.setPointerCapture(e.pointerId);
      gutter.addEventListener('pointermove', onMove);
      gutter.addEventListener('pointerup', onUp);
    });
  }

  function selectRow(vr, extend) {
    if (!numCols()) return;
    if (extend && sel) { sel.er = vr; }
    else sel = { ar: vr, ac: 0, er: vr, ec: numCols() - 1 };
    sel.ac = 0;
    sel.ec = numCols() - 1;
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
        const startW = colW[c];
        const onMove = (ev) => {
          colW[c] = Math.max(MINW, startW + ev.clientX - startX);
          renderHead();
          render();
        };
        const onUp = () => {
          colhead.removeEventListener('pointermove', onMove);
          colhead.removeEventListener('pointerup', onUp);
          saveColW();
        };
        colhead.setPointerCapture(e.pointerId);
        colhead.addEventListener('pointermove', onMove);
        colhead.addEventListener('pointerup', onUp);
        return;
      }
      const h = e.target.closest('.hcell');
      if (!h) return;
      e.preventDefault();
      clip.focus({ preventScroll: true });
      const c = +h.dataset.c;
      if (e.button === 2) {
        const ro = !T || !T.editable;
        showCtx(e.clientX, e.clientY, [
          { label: 'Sort ascending', fn: () => { sortCol = c; sortDir = 1; renderAll(); } },
          { label: 'Sort descending', fn: () => { sortCol = c; sortDir = -1; renderAll(); } },
          { label: 'Clear sort', disabled: sortDir === 0,
            fn: () => { sortDir = 0; sortCol = -1; renderAll(); } },
          '-',
          { label: 'Insert column left', disabled: ro, fn: () => cbs.insertCols(c, 1) },
          { label: 'Insert column right', disabled: ro, fn: () => cbs.insertCols(c + 1, 1) },
          { label: 'Delete column', disabled: ro || numCols() < 2,
            fn: () => cbs.deleteCols([c]) },
        ]);
        return;
      }
      if (e.button !== 0) return;
      // click cycles sort: asc -> desc -> off
      if (sortCol !== c || sortDir === 0) { sortCol = c; sortDir = 1; }
      else if (sortDir === 1) sortDir = -1;
      else { sortDir = 0; sortCol = -1; }
      renderAll();
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
      <div id="emptystate">NO TARGET TABLE</div>
      <textarea id="clip" tabindex="-1" autocomplete="off"></textarea>`;
    body = el.querySelector('#body');
    spacer = el.querySelector('#spacer');
    rowsEl = el.querySelector('#rows');
    colheadInner = el.querySelector('#colheadinner');
    gutterInner = el.querySelector('#gutterinner');
    emptyEl = el.querySelector('#emptystate');
    dropline = el.querySelector('#dropline');
    clip = el.querySelector('#clip');
    clip.addEventListener('keydown', (e) => { if (!editing) handleKey(e); });
    document.addEventListener('pointerdown', (e) => {
      if (ctxEl && !ctxEl.contains(e.target)) closeCtx();
    });
    window.addEventListener('resize', requestRender);
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

  return { init, setTable, applyEdits, setFilter, dims };
})();
