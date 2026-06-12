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

  // comp Style page -> CSS vars; rides on every {t:table} and as live
  // {t:style} broadcasts when a Style par changes
  const STYLE_VARS = {
    bg: '--bg', panel: '--panel', cell: '--cell', cellalt: '--cell-alt',
    grid: '--grid-line', header: '--header-bg', gutter: '--gutter-bg',
    text: '--text', textdim: '--text-dim', accent: '--accent',
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
    Grid.setStyle({ rowh: s.rowh });
  }

  Grid.init($('grid'), {
    edit: (edits) => Bridge.send({ t: 'edit', edits }),
    insertRows: (at, rows) => Bridge.send({ t: 'insertrows', at, rows }),
    deleteRows: (rows) => Bridge.send({ t: 'deleterows', rows }),
    moveRows: (rows, to) => Bridge.send({ t: 'moverows', rows, to }),
    insertCols: (at, count) => Bridge.send({ t: 'insertcols', at, count }),
    deleteCols: (cols) => Bridge.send({ t: 'deletecols', cols }),
    moveCols: (cols, to) => Bridge.send({ t: 'movecols', cols, to }),
    applySort: (rows) => Bridge.send({ t: 'reorder', rows }),
    select: (sel) => Bridge.send({ t: 'sel', sel }),
    clip: (text) => Bridge.send({ t: 'clip', text }),
    status: (s) => {
      dimsEl.textContent = s.dims || '';
      selEl.textContent = s.sel || '';
    },
  });

  Bridge.init({
    message(msg) {
      if (msg.t === 'style') {
        applyStyle(msg.style);
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

  filterEl.addEventListener('input', () => Grid.setFilter(filterEl.value));
  filterEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      filterEl.value = '';
      Grid.setFilter('');
      filterEl.blur();
    }
    e.stopPropagation();
  });

  $('btn-addrow').addEventListener('click', () => {
    const d = Grid.dims();
    if (d && d.editable) Bridge.send({ t: 'insertrows', at: d.rows, rows: [[]] });
  });

  $('btn-addcol').addEventListener('click', () => {
    const d = Grid.dims();
    if (d && d.editable) Bridge.send({ t: 'insertcols', at: d.cols, count: 1 });
  });

  headerCb.addEventListener('change', () => {
    Bridge.send({ t: 'setheader', on: headerCb.checked });
  });
})();
