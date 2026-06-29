/*
 * Bridge: WebSocket connection to the TD webserverDAT, with a mock loopback
 * mode (?mock=1, or file:// pages) so the grid can be developed in any
 * browser without TouchDesigner running.
 *
 * Client -> TD: {t:'hello'} {t:'edit',edits:[{r,c,v}]}
 *   {t:'insertrows',at,rows} {t:'deleterows',rows} {t:'moverows',rows,to}
 *   {t:'insertcols',at,count} {t:'deletecols',cols} {t:'movecols',cols,to}
 *   {t:'setheader',on} {t:'settable',path}
 * TD -> client: {t:'table',rev,path,name,editable,headerRow,cells}
 *   {t:'delta',rev,edits:[{r,c,v}]} {t:'error',msg}
 *
 * All r/c are DAT coordinates (header row included). The mock mirrors the
 * ext's op handling so every grid feature is testable offline.
 */
const Bridge = (() => {
  const RETRY_MS = 2000;
  let ws = null;
  let mock = false;
  let handlers = { message: () => {}, status: () => {} };

  const params = new URLSearchParams(location.search);
  const wantMock = params.get('mock') === '1' || location.protocol === 'file:';

  // ---- mock mode ---------------------------------------------------------
  const COLORS = ['red', 'amber', 'cyan', 'magenta', 'blue', 'green', 'white'];
  const NAMES = ['Doors', 'Intro', 'Build', 'Drop', 'Breakdown', 'Bridge',
    'Strobe Hit', 'Blackout', 'Outro', 'Encore'];

  function mockCells() {
    const cells = [['cue', 'name', 'duration', 'color', 'bpm', 'notes']];
    for (let i = 1; i <= 60; i++) {
      cells.push([
        String(i),
        NAMES[i % NAMES.length] + ' ' + Math.ceil(i / NAMES.length),
        String(30 + ((i * 37) % 240)),
        COLORS[i % COLORS.length],
        String(120 + (i % 8) * 2),
        i % 7 === 0 ? 'haze 50%, blinders armed' : (i % 5 === 0 ? 'strobe warning' : ''),
      ]);
    }
    return cells;
  }

  const MOCK = {
    rev: 0,
    path: '/project1/mock_cues',
    name: 'mock_cues (no TD)',
    editable: true,
    headerRow: true,
    cells: mockCells(),
  };

  // colDefine entries ({column: {props}}, insertion-ordered) — the mock
  // applies setcoldef and resolves uicols like the ext (no python: expr
  // columns evaluate to '')
  const MOCKDEF = new Map();

  function mockUiCols() {
    const names = MOCK.headerRow && MOCK.cells.length
      ? MOCK.cells[0].map(String)
      : (MOCK.cells[0] || []).map((_, i) => 'c' + i);
    const defs = [];
    for (const [name, p] of MOCKDEF) {
      defs.push({
        name,
        label: (p.label || '*') === '*' ? name : p.label,
        src: names.indexOf(p.source || ''),
        mode: p.mode || 'text',
        expr: p.expr || '',
        icon: p.icon || '',
        visible: String(p.visible ?? '1') !== '0',
        width: p.width || '',
        editable: String(p.editable ?? '1') !== '0',
      });
    }
    return defs;
  }

  function mockTableMsg() {
    MOCK.rev += 1;
    return {
      t: 'table', rev: MOCK.rev, path: MOCK.path, name: MOCK.name,
      editable: MOCK.editable, headerRow: MOCK.headerRow,
      uicols: mockUiCols(), uivals: {},
      cells: MOCK.cells.map((r) => r.slice()),
    };
  }

  function later(msg) { setTimeout(() => handlers.message(msg), 16); }

  function clampIdx(i, n) { return Math.max(0, Math.min(i, n)); }

  function mockSend(msg) {
    const cells = MOCK.cells;
    const ncols = cells[0] ? cells[0].length : 0;
    if (msg.t === 'hello') {
      later(mockTableMsg());
    } else if (msg.t === 'setcoldef') {
      for (const e of msg.defs || []) {
        if (!e.column) continue;
        if (e.set === undefined || e.set === null) MOCKDEF.delete(e.column);
        else MOCKDEF.set(e.column, Object.assign(MOCKDEF.get(e.column) || {}, e.set));
      }
      later(mockTableMsg());
    } else if (msg.t === 'edit') {
      const applied = [];
      for (const e of msg.edits || []) {
        if (cells[e.r] && e.c >= 0 && e.c < ncols) {
          cells[e.r][e.c] = String(e.v ?? '');
          applied.push({ r: e.r, c: e.c, v: cells[e.r][e.c] });
        }
      }
      if (applied.length) {
        MOCK.rev += 1;
        later({ t: 'delta', rev: MOCK.rev, edits: applied });
      }
    } else if (msg.t === 'insertrows') {
      const at = clampIdx(msg.at | 0, cells.length);
      const block = (msg.rows && msg.rows.length ? msg.rows : [[]]).map((r) => {
        const row = (r || []).map(String).slice(0, ncols);
        while (row.length < ncols) row.push('');
        return row;
      });
      cells.splice(at, 0, ...block);
      later(mockTableMsg());
    } else if (msg.t === 'deleterows') {
      const drop = new Set((msg.rows || []).filter((r) => r >= 0 && r < cells.length));
      if (drop.size && drop.size < cells.length) {
        MOCK.cells = cells.filter((_, i) => !drop.has(i));
        later(mockTableMsg());
      }
    } else if (msg.t === 'moverows') {
      const take = [...new Set(msg.rows || [])].filter((r) => r >= 0 && r < cells.length).sort((a, b) => a - b);
      if (take.length) {
        const block = take.map((i) => cells[i]);
        const taken = new Set(take);
        const rest = cells.filter((_, i) => !taken.has(i));
        const ins = clampIdx((msg.to | 0) - take.filter((i) => i < msg.to).length, rest.length);
        MOCK.cells = [...rest.slice(0, ins), ...block, ...rest.slice(ins)];
        later(mockTableMsg());
      }
    } else if (msg.t === 'insertcols') {
      const at = clampIdx(msg.at | 0, ncols);
      const count = Math.max(1, msg.count | 0);
      for (const row of cells) row.splice(at, 0, ...Array(count).fill(''));
      later(mockTableMsg());
    } else if (msg.t === 'deletecols') {
      const drop = new Set((msg.cols || []).filter((c) => c >= 0 && c < ncols));
      if (drop.size && drop.size < ncols) {
        MOCK.cells = cells.map((row) => row.filter((_, i) => !drop.has(i)));
        later(mockTableMsg());
      }
    } else if (msg.t === 'movecols') {
      const take = [...new Set(msg.cols || [])].filter((c) => c >= 0 && c < ncols).sort((a, b) => a - b);
      if (take.length) {
        const taken = new Set(take);
        const ins = clampIdx((msg.to | 0) - take.filter((i) => i < msg.to).length, ncols - take.length);
        MOCK.cells = cells.map((row) => {
          const block = take.map((i) => row[i]);
          const rest = row.filter((_, i) => !taken.has(i));
          return [...rest.slice(0, ins), ...block, ...rest.slice(ins)];
        });
        later(mockTableMsg());
      }
    } else if (msg.t === 'replace') {
      MOCK.cells = (msg.cells || []).map((r) => r.map(String));
      later(mockTableMsg());
    } else if (msg.t === 'reorder') {
      // full data-row permutation (header rows keep their place)
      const hdr = MOCK.headerRow ? 1 : 0;
      const valid = [...new Set(msg.rows || [])].filter((r) => r >= hdr && r < cells.length);
      const seen = new Set(valid);
      const missing = [];
      for (let i = hdr; i < cells.length; i++) if (!seen.has(i)) missing.push(i);
      MOCK.cells = [...cells.slice(0, hdr), ...valid.map((r) => cells[r]),
        ...missing.map((r) => cells[r])];
      later(mockTableMsg());
    } else if (msg.t === 'sel') {
      MOCK.lastSel = msg.sel;        // inspectable in tests; TD writes DATs
    } else if (msg.t === 'button' || msg.t === 'click') {
      MOCK.lastClick = msg;          // TD routes onClick<Column>/onClick
    } else if (msg.t === 'clip') {
      MOCK.lastClip = msg.text;
    } else if (msg.t === 'setheader') {
      MOCK.headerRow = !!msg.on;
      later(mockTableMsg());
    } else if (msg.t === 'settable') {
      MOCK.name = String(msg.path || MOCK.name);
      later(mockTableMsg());
    }
  }

  // ---- real socket ---------------------------------------------------------
  function connect() {
    if (mock) {
      handlers.status('mock');
      mockSend({ t: 'hello' });
      return;
    }
    handlers.status('down');
    ws = new WebSocket(`ws://${location.host}`);
    ws.onopen = () => {
      handlers.status('ok');
      send({ t: 'hello' });
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handlers.message(msg);
    };
    ws.onclose = () => {
      handlers.status('down');
      ws = null;
      setTimeout(connect, RETRY_MS);
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }

  function send(msg) {
    if (mock) { mockSend(msg); return; }
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function init(opts) {
    handlers = Object.assign(handlers, opts);
    mock = wantMock;
    connect();
  }

  return { init, send, isMock: () => mock };
})();
