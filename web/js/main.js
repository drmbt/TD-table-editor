/* main: wires Bridge (transport) to Grid (view/editor) and the toolbar. */
(() => {
  const $ = (id) => document.getElementById(id);
  const targetEl = $('targetname');
  const roBadge = $('robadge');
  const connEl = $('conn');
  const dimsEl = $('dims');
  const selEl = $('selinfo');
  const hintEl = $('hint');
  const headerCb = $('headerrow');
  const filterEl = $('filter');

  let table = null;

  // footer action log (comp par Displaylog -> style.showlog; &log=1 in
  // mock). Last action only — feedback, not history.
  const logEl = $('oplog');
  let showLog = new URLSearchParams(location.search).get('log') === '1';
  function logAction(msg) {
    if (!showLog || !msg) return;
    logEl.textContent = msg;
    logEl.hidden = false;
  }

  // comp Style page -> CSS vars; rides on every {t:table} and as live
  // {t:style} broadcasts when a Style par changes
  const STYLE_VARS = {
    bg: '--bg', panel: '--panel', cell: '--cell', cellalt: '--cell-alt',
    grid: '--grid-line', header: '--header-bg', gutter: '--gutter-bg',
    text: '--text', textdim: '--text-dim', accent: '--accent',
    highlight: '--hl',
  };

  function applyStyle(s) {
    if (!s) return;
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(STYLE_VARS)) {
      if (s[k]) root.setProperty(v, s[k]);
    }
    if (s.font) root.setProperty('--font-family', s.font);
    if (s.fontsize) root.setProperty('--fontsize', s.fontsize + 'px');
    if (s.rowh) root.setProperty('--rowh', s.rowh + 'px');
    if ('showlog' in s) {
      showLog = !!s.showlog;
      logEl.hidden = !showLog || !logEl.textContent;
    }
    Grid.setStyle({ rowh: s.rowh });
  }

  const clipWaiters = [];

  Grid.init($('grid'), {
    edit: (edits) => Bridge.send({ t: 'edit', edits }),
    insertRows: (at, rows) => Bridge.send({ t: 'insertrows', at, rows }),
    deleteRows: (rows) => Bridge.send({ t: 'deleterows', rows }),
    moveRows: (rows, to) => Bridge.send({ t: 'moverows', rows, to }),
    insertCols: (at, count) => Bridge.send({ t: 'insertcols', at, count }),
    deleteCols: (cols) => Bridge.send({ t: 'deletecols', cols }),
    moveCols: (cols, to) => Bridge.send({ t: 'movecols', cols, to }),
    applySort: (rows) => Bridge.send({ t: 'reorder', rows }),
    replace: (cells) => Bridge.send({ t: 'replace', cells }),
    select: (sel) => Bridge.send({ t: 'sel', sel }),
    clip: (text) => Bridge.send({ t: 'clip', text }),
    // clipboard pull (gutter "Insert clipboard rows here"): connected
    // pages ask TD for ui.clipboard ({t:getclip} -> {t:clip} reply) —
    // it IS the OS clipboard, and works in offscreen CEF too; mock
    // mode falls back to the browser clipboard API
    getClip: (cb) => {
      if (Bridge.isMock()) {
        navigator.clipboard.readText().then(cb).catch(() => cb(''));
        return;
      }
      clipWaiters.push(cb);
      Bridge.send({ t: 'getclip' });
      setTimeout(() => {           // never strand the callback
        const i = clipWaiters.indexOf(cb);
        if (i >= 0) { clipWaiters.splice(i, 1); cb(''); }
      }, 1500);
    },
    status: (s) => {
      dimsEl.textContent = s.dims || '';
      selEl.textContent = s.sel || '';
      $('btn-applysort').disabled = !s.sortApplicable;
    },
    log: logAction,
    cursor: (name) => Bridge.send({ t: 'cursor', name }),
    button: (r, c, col) => Bridge.send({ t: 'button', r, c, col: col || '' }),
    click: (r, c, col) => Bridge.send({ t: 'click', r, c, col: col || '' }),
    setColDef: (defs) => Bridge.send({ t: 'setcoldef', defs }),
  });

  Bridge.init({
    message(msg) {
      if (msg.t === 'style') {
        applyStyle(msg.style);
      } else if (msg.t === 'reload') {
        location.reload();      // Reloadclients pulse: stale-page recovery
      } else if (msg.t === 'resetview') {
        Grid.resetView(msg.path);   // Resetconfig pulse: drop saved view state
      } else if (msg.t === 'table') {
        table = msg;
        if (msg.style) applyStyle(msg.style);
        targetEl.textContent = msg.name || '—';
        targetEl.title = msg.path || 'no target table';
        roBadge.hidden = !!msg.editable;
        headerCb.checked = !!msg.headerRow;
        $('btn-addrow').disabled = !msg.editable;
        $('btn-addcol').disabled = !msg.editable;
        Grid.setTable(msg);
      } else if (msg.t === 'delta') {
        Grid.applyEdits(msg.edits || []);
      } else if (msg.t === 'uivals') {
        Grid.setUiVals(msg.vals || {});
      } else if (msg.t === 'clip') {
        const w = clipWaiters.splice(0, clipWaiters.length);
        w.forEach((cb) => cb(msg.text || ''));
      } else if (msg.t === 'error') {
        hintEl.textContent = msg.msg || 'error';
        setTimeout(() => { hintEl.textContent = ''; }, 4000);
      }
    },
    status(s) {
      connEl.className = 'conn ' + s;
      connEl.title = s === 'ok' ? 'connected to TD'
        : (s === 'mock' ? 'mock mode (no TD)' : 'disconnected');
    },
  });

  const clearFilterBtn = $('btn-clearfilter');
  function syncClearBtn() { clearFilterBtn.hidden = !filterEl.value; }
  filterEl.addEventListener('input', () => {
    Grid.setFilter(filterEl.value);
    syncClearBtn();
  });
  filterEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      filterEl.value = '';
      Grid.setFilter('');
      filterEl.blur();
      syncClearBtn();
    }
    e.stopPropagation();
  });
  clearFilterBtn.addEventListener('click', () => {
    filterEl.value = '';
    Grid.setFilter('');
    syncClearBtn();
  });

  $('btn-addrow').addEventListener('click', () => Grid.appendRow());
  $('btn-addcol').addEventListener('click', () => Grid.appendCol());
  $('btn-applysort').addEventListener('click', () => Grid.applySortToDAT());
  $('btn-refresh').addEventListener('click', () => Bridge.send({ t: 'refresh' }));
  $('btn-openpars').addEventListener('click', () => Bridge.send({ t: 'openpars' }));

  headerCb.addEventListener('change', () => {
    Bridge.send({ t: 'setheader', on: headerCb.checked });
  });

  window.__applyStyle = applyStyle;   // manual/debug hook (CEF devtools-less)
})();
