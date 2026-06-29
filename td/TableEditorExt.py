"""
TableEditorExt — extension for the TableEditor comp.

Bi-directional sync between a target table DAT and browser clients over a
webserverDAT WebSocket. TD is the source of truth: clients send edit ops,
the ext writes the DAT and broadcasts the result to every client. The ext
keeps a snapshot of the target table; its own writes update the snapshot
first, so the datexec-driven change handler can tell self-echoes (table ==
snapshot, skip) from external changes (diff -> delta broadcast).

Wire coordinates are always DAT coordinates. View state (sort, filter,
column widths, selection) lives in the page and never reaches TD.
"""

import fnmatch
import json


def _undoRestore(isUndo, info):
	"""ui.undo callback: restore a captured state. Python DAT writes are
	invisible to TD's native undo (verified 2025.32820), so every ext
	write registers one of these. Module-level + path-resolved so the
	reference TD's undo queue holds survives extension reinit; the
	restore lands like any external script write — the datexec diff
	path broadcasts it to every client."""
	o = op(info['path'])
	if o is None:
		return
	data = info['undo'] if isUndo else info['redo']
	try:
		kind = info['kind']
		if kind == 'edit':
			for r, c, v in data:
				if 0 <= r < o.numRows and 0 <= c < o.numCols:
					o[r, c] = v
		elif kind == 'table':
			o.clear()
			for row in data:
				o.appendRow(row)
		elif kind == 'par':
			setattr(o.par, info['name'], data)
	except Exception as e:
		debug('TableEditor: TD undo restore failed: %s' % e)


class TableEditorExt:

	def __init__(self, ownerComp):
		self.ownerComp = ownerComp
		# defer: mutating the comp during its own cook trips a cook
		# dependency loop that silently disables parexecs (see CLAUDE.md)
		run('args[0]._ensureSetup()', self, delayFrames=1, fromOP=ownerComp)
		self.clients = set()
		try:
			# survive extension reinit: connections outlive this object
			self.clients.update(self.webserver.webSocketConnections)
		except Exception:
			pass
		self.rev = 0
		self._snap = None       # list[list[str]] cache of the target table
		self._kickN = 0
		self._styleQueued = False
		# in-TD modifier state, tracked from keyboardin key events (panel
		# CHOP modifier channels don't follow bare key presses, and
		# interactMouse carries no modifier flags) — pushed into the page
		# as window.__tdMods so pointer handlers can merge it
		self._mods = {'shift': False, 'ctrl': False,
					  'alt': False, 'cmd': False}
		self.OnTargetChange()

	@property
	def webserver(self):
		return self.ownerComp.op('webserver1')

	# ---- idempotent setup / migration --------------------------------------
	# Canonical copies of the in-comp callback DAT texts live here so repo
	# updates apply on reinitextensions (build_component creates bare DATs).

	_PE2_PARS = ('Targetop Headerrow Refresh Openinbrowser Openviewer'
				 ' Displaylog'
				 ' Reloadclients Resetconfig'
				 ' Bgcolor* Panelcolor* Cellcolor* Cellaltcolor* Gridcolor*'
				 ' Headercolor* Guttercolor* Textcolor* Textdimcolor*'
				 ' Accentcolor* Highlightcolor* Fontfamily Fontsize Rowheight'
				 ' Theme')

	_PE2_TEXT = (
		"def onPulse(par):\n"
		"\text = parent().ext.TableEditorExt\n"
		"\tif par.name == 'Refresh':\n"
		"\t\text.Refresh()\n"
		"\telif par.name == 'Openinbrowser':\n"
		"\t\timport webbrowser\n"
		"\t\twebbrowser.open('http://127.0.0.1:%d/' % parent().par.Port.eval())\n"
		"\telif par.name == 'Openviewer':\n"
		"\t\text.OpenWindow()\n"
		"\telif par.name == 'Reloadclients':\n"
		"\t\text.ReloadClients()\n"
		"\telif par.name == 'Resetconfig':\n"
		"\t\text.ResetConfig()\n"
		"\treturn\n"
		"\n"
		"def onValueChange(par, prev):\n"
		"\text = parent().ext.TableEditorExt\n"
		"\tif par.name == 'Targetop':\n"
		"\t\text.OnTargetChange()\n"
		"\telif par.name == 'Headerrow':\n"
		"\t\text.Refresh()\n"
		"\telif par.name == 'Theme':\n"
		"\t\text.ApplyTheme(par.eval())\n"
		"\telse:\n"
		"\t\text.OnStyleChange()  # Style page pars\n"
		"\treturn\n")

	# Style page: par name -> (label, default rgb) ; broadcast as hex CSS
	# vars to every client. Defaults mirror web/css/theme.css.
	_STYLE_COLORS = (
		('Bgcolor', 'Background', (0.086, 0.094, 0.110)),
		('Panelcolor', 'Toolbar', (0.114, 0.125, 0.149)),
		('Cellcolor', 'Cell', (0.102, 0.114, 0.133)),
		('Cellaltcolor', 'Cell Alternate', (0.114, 0.129, 0.153)),
		('Gridcolor', 'Grid Lines', (0.165, 0.180, 0.212)),
		('Headercolor', 'Column Header', (0.137, 0.153, 0.188)),
		('Guttercolor', 'Row Gutter', (0.122, 0.137, 0.169)),
		('Textcolor', 'Text', (0.847, 0.855, 0.871)),
		('Textdimcolor', 'Text Dim', (0.545, 0.565, 0.604)),
		('Accentcolor', 'Accent', (0.373, 0.706, 1.0)),
		('Highlightcolor', 'Highlight', (0.373, 0.706, 1.0)),
	)

	_STYLE_INTS = (
		('Rowheight', 'Row Height', 18, 48, 26),
		('Fontsize', 'Font Size', 10, 20, 13),
	)

	# Font Family dropdown (the page applies these as CSS font-family).
	# Every name verified to actually render in webrender CEF on macOS via
	# canvas width-measurement (document.fonts.check lies — it passed
	# Consolas/Roboto, which fall back to the default). Alphabetical.
	_FONTS = [
		'American Typewriter', 'Andale Mono', 'Arial', 'Avenir',
		'Baskerville', 'Courier', 'Courier New', 'Futura', 'Georgia',
		'Gill Sans', 'Helvetica', 'Helvetica Neue', 'Menlo', 'Monaco',
		'monospace', 'Optima', 'Palatino', 'PT Mono', 'sans-serif',
		'serif', 'system-ui', 'Tahoma', 'Times New Roman',
		'Trebuchet MS', 'Verdana',
	]

	_THEMES = {
		'dark': {
			'Bgcolor': (0.086, 0.094, 0.110), 'Panelcolor': (0.114, 0.125, 0.149),
			'Cellcolor': (0.102, 0.114, 0.133), 'Cellaltcolor': (0.114, 0.129, 0.153),
			'Gridcolor': (0.165, 0.180, 0.212), 'Headercolor': (0.137, 0.153, 0.188),
			'Guttercolor': (0.122, 0.137, 0.169), 'Textcolor': (0.847, 0.855, 0.871),
			'Textdimcolor': (0.545, 0.565, 0.604), 'Accentcolor': (0.373, 0.706, 1.0),
			'Highlightcolor': (0.373, 0.706, 1.0),
		},
		# off-white text on near-black, charcoal cells, reddish-orange
		# accent, desaturated yellow highlight (Vincent's house style)
		'drmbt': {
			'Bgcolor': (0.067, 0.067, 0.071), 'Panelcolor': (0.118, 0.118, 0.125),
			'Cellcolor': (0.102, 0.102, 0.106), 'Cellaltcolor': (0.118, 0.118, 0.122),
			'Gridcolor': (0.176, 0.176, 0.184), 'Headercolor': (0.137, 0.137, 0.145),
			'Guttercolor': (0.110, 0.110, 0.114), 'Textcolor': (0.949, 0.937, 0.910),
			'Textdimcolor': (0.604, 0.588, 0.553), 'Accentcolor': (1.0, 0.3, 0.3),
			'Highlightcolor': (0.780, 0.710, 0.450),
		},
		'light': {
			'Bgcolor': (0.910, 0.918, 0.933), 'Panelcolor': (0.957, 0.961, 0.973),
			'Cellcolor': (1.0, 1.0, 1.0), 'Cellaltcolor': (0.953, 0.961, 0.973),
			'Gridcolor': (0.831, 0.847, 0.875), 'Headercolor': (0.890, 0.902, 0.925),
			'Guttercolor': (0.925, 0.933, 0.949), 'Textcolor': (0.165, 0.176, 0.200),
			'Textdimcolor': (0.420, 0.439, 0.467), 'Accentcolor': (0.165, 0.435, 0.722),
			'Highlightcolor': (0.165, 0.435, 0.722),
		},
		'synthwave': {
			'Bgcolor': (0.039, 0.039, 0.071), 'Panelcolor': (0.082, 0.071, 0.169),
			'Cellcolor': (0.094, 0.078, 0.200), 'Cellaltcolor': (0.110, 0.090, 0.224),
			'Gridcolor': (0.173, 0.141, 0.322), 'Headercolor': (0.125, 0.102, 0.251),
			'Guttercolor': (0.102, 0.082, 0.208), 'Textcolor': (0.847, 0.831, 0.910),
			'Textdimcolor': (0.561, 0.525, 0.678), 'Accentcolor': (0.706, 0.373, 1.0),
			'Highlightcolor': (0.706, 0.373, 1.0),
		},
	}

	_DE_TEXT = (
		"def onTableChange(dat):\n"
		"\tparent().ext.TableEditorExt.OnTableChange()\n"
		"\treturn\n")

	_CE_TEXT = (
		"def onValueChange(channel, sampleIndex, val, prev):\n"
		"\tc = channel.owner\n"
		"\text = parent().ext.TableEditorExt\n"
		"\tif channel.name in ('shift', 'ctrl', 'alt'):\n"
		"\t\t# panel modifier channels rarely transition (focus-gated),\n"
		"\t\t# but when they do it's real state — fold into the tracker\n"
		"\t\text.OnModifierKey(channel.name, bool(val))\n"
		"\t\treturn\n"
		"\tif channel.name == 'wheel':\n"
		"\t\t# panel wheel is an instantaneous displacement (then snaps to 0)\n"
		"\t\ttry:\n"
		"\t\t\tshift = bool(float(c['shift']))\n"
		"\t\texcept Exception:\n"
		"\t\t\tshift = False\n"
		"\t\text.ForwardWheel(float(c['insideu']), float(c['insidev']),\n"
		"\t\t                 val, shift)\n"
		"\telse:\n"
		"\t\text.ForwardMouse(float(c['u']), float(c['v']),\n"
		"\t\t                 float(c['insideu']), float(c['insidev']),\n"
		"\t\t                 float(c['lselect']), float(c['inside']),\n"
		"\t\t                 float(c['rselect']))\n"
		"\treturn\n")

	# keyboardinDAT body is its read-only key-log table; callbacks go in the
	# auto-created '<name>_callbacks'. 2025.32820 signature: keyInfo
	# namedtuple with key/character/shift/state members.
	_KB_TEXT = (
		"def onKey(dat, keyInfo):\n"
		"\text = parent().ext.TableEditorExt\n"
		"\tk = str(keyInfo.key or '')\n"
		"\tif k in ('shift', 'lshift', 'rshift', 'ctrl', 'lctrl', 'rctrl',\n"
		"\t\t\t'alt', 'lalt', 'ralt', 'cmd', 'lcmd', 'rcmd'):\n"
		"\t\t# modifiers arrive as their own key events, both states\n"
		"\t\text.OnModifierKey(k, keyInfo.state)\n"
		"\t\treturn\n"
		"\tif not keyInfo.state:\n"
		"\t\treturn\n"
		"\tcmd = bool(getattr(keyInfo, 'cmd', False))\n"
		"\tctrl = bool(getattr(keyInfo, 'ctrl', False))\n"
		"\talt = bool(getattr(keyInfo, 'alt', False))\n"
		"\t# chord flags are authoritative — recover from missed keyups\n"
		"\text.SyncMods(bool(keyInfo.shift), ctrl, alt, cmd)\n"
		"\text.ForwardKey(keyInfo.key, keyInfo.character, keyInfo.shift,\n"
		"\t\tctrl, alt, cmd)\n"
		"\treturn\n")

	# user-editable callbacks DAT template — created once, NEVER rewritten
	# (unlike the canonical callback DATs above, the user owns this text)
	_CB_TEXT = (
		'"""TableEditor user callbacks (Lister-style).\n\n'
		'Point the Callback DAT par at any DAT defining these functions.\n'
		'Every info dict carries ownerComp (the TableEditor comp) and\n'
		'target (the table DAT). All r/c are DAT coordinates.\n'
		'"""\n'
		'\n'
		'# def onSelect(info):\n'
		'#     """Selection changed. info: rows (DAT row indices),\n'
		'#     c0, c1 (column span of the active rect)."""\n'
		'#     pass\n'
		'\n'
		'# def onButtonClick(info):\n'
		'#     """A button-format cell was clicked. info: row, col,\n'
		'#     cells (the FULL row, hidden columns included) — e.g.\n'
		'#     op(info[\'cells\'][3]).par.play.pulse()."""\n'
		'#     pass\n'
		'\n'
		'# def onClick(info):\n'
		'#     """Universal click on ANY cell (data or virtual UI column).\n'
		'#     info: row, col, column (UI/DAT column name), cells (FULL row),\n'
		'#     cellsByName, target. Fires unless a more specific\n'
		'#     onClick<Column> is defined. e.g. for a hidden \'path\' column:\n'
		'#     op(info[\'cellsByName\'][\'path\']).par.play.pulse()."""\n'
		'#     pass\n'
		'\n'
		'# def onClickIcon(info):\n'
		'#     """Named click: fires for a button/thumb/virtual column named\n'
		'#     "icon" (onClick + Capitalized column name). Beats onClick /\n'
		'#     onButtonClick. A virtual `delete` column removes the row on\n'
		'#     its own — define onClickDelete only to add a confirm/hook."""\n'
		'#     pass\n'
		'\n'
		'# def onEdit(info):\n'
		'#     """Cells written. info: edits [{r,c,v}], prev [(r,c,old)]."""\n'
		'#     pass\n'
		'\n'
		'# def onStructure(info):\n'
		'#     """Table shape changed. info: kind (insertrows/deleterows/\n'
		'#     moverows/insertcols/deletecols/movecols/reorder/replace),\n'
		'#     msg (the raw op)."""\n'
		'#     pass\n'
		'\n'
		'# def onTargetChange(info):\n'
		'#     """Editor retargeted. info: path."""\n'
		'#     pass\n')

	def _ensureSetup(self):
		comp = self.ownerComp
		# pars added after the initial build land on the main page here
		try:
			tp = getattr(comp.par, 'Targetop', None)
			mainPage = (tp.page if tp is not None
						else comp.appendCustomPage('Table Editor'))
			if getattr(comp.par, 'Reloadclients', None) is None:
				mainPage.appendPulse('Reloadclients',
									 label='Reload Web Clients')
			if getattr(comp.par, 'Resetconfig', None) is None:
				mainPage.appendPulse('Resetconfig',
									 label='Reset Config (Auto)')
			if getattr(comp.par, 'Displaylog', None) is None:
				p = mainPage.appendToggle('Displaylog',
										  label='Display Log')[0]
				p.default = p.val = False
			cb = comp.op('callbacks')
			if cb is None:
				cb = comp.create(textDAT, 'callbacks')
				cb.nodeX, cb.nodeY = 0, -400
				cb.text = self._CB_TEXT
			if getattr(comp.par, 'Callbackdat', None) is None:
				p = mainPage.appendOP('Callbackdat',
									  label='Callback DAT')[0]
				p.val = './callbacks'
			cd = comp.op('colDefine')
			if cd is None:
				cd = comp.create(tableDAT, 'colDefine')
				cd.nodeX, cd.nodeY = 200, -400
			# seed property rows whenever the DAT is empty (not only at
			# creation — a failed first init must heal on the next one)
			if cd.numRows == 0 or (cd.numRows == 1 and cd.numCols == 1
									and not cd[0, 0].val.strip()):
				cd.clear()
				for rname in self._COLDEF_ROWS:
					cd.appendRow([rname])
			if getattr(comp.par, 'Coldefine', None) is None:
				p = mainPage.appendOP('Coldefine',
									  label='Column Define DAT')[0]
				p.val = './colDefine'
			# colDefine + its par now exist; fully define it for the current
			# target and rebroadcast (init's OnTargetChange ran before this
			# deferred setup created colDefine, so it couldn't populate then)
			self._syncColDef()
			self._broadcastTable()
		except Exception as e:
			debug('TableEditor: main par setup failed: %s' % e)
		# Style page (idempotent, per-par: new pars append on reinit)
		try:
			page = None
			for pg in comp.customPages:
				if pg.name == 'Style':
					page = pg
					break
			if page is None:
				page = comp.appendCustomPage('Style')
			for name, label, rgb in self._STYLE_COLORS:
				if getattr(comp.par, name + 'r', None) is None:
					g = page.appendRGB(name, label=label)
					for p, v in zip(g, rgb):
						p.default = v
						p.val = v
			if getattr(comp.par, 'Fontfamily', None) is None:
				page.appendStrMenu('Fontfamily', label='Font Family')
			# StrMenu dropdown of valid families (free text still typeable),
			# menu items synced every init. Migrate pre-existing plain-Str
			# pars: menuNames raises 'Expected menu parameter' on a Str
			# (verified live), so destroy + recreate in place.
			fp = comp.par.Fontfamily
			if fp.style != 'StrMenu':
				old_val, old_order = fp.eval(), fp.order
				fp.destroy()
				fp = page.appendStrMenu('Fontfamily',
										label='Font Family')[0]
				fp.val = old_val
				fp.order = old_order
			if list(fp.menuNames or []) != self._FONTS:
				fp.menuNames = self._FONTS
				fp.menuLabels = self._FONTS
			for name, label, lo, hi, dv in self._STYLE_INTS:
				if getattr(comp.par, name, None) is None:
					p = page.appendInt(name, label=label)[0]
					p.normMin, p.normMax = lo, hi
					p.default = p.val = dv
			if getattr(comp.par, 'Theme', None) is None:
				page.appendMenu('Theme', label='Theme')
			# menu items sync every init — themes added after the par was
			# created (e.g. drmbt) must land on existing comps too
			p = comp.par.Theme
			names = ['custom'] + sorted(self._THEMES)
			if list(p.menuNames or []) != names:
				p.menuNames = names
				p.menuLabels = [n.capitalize() for n in names]
		except Exception as e:
			debug('TableEditor: style page setup failed: %s' % e)
		pe2 = comp.op('parexec_self')
		if pe2 is not None:
			if pe2.par.pars.eval() != self._PE2_PARS:
				pe2.par.pars = self._PE2_PARS
			if pe2.text != self._PE2_TEXT:
				pe2.text = self._PE2_TEXT
		de = comp.op('datexec_target')
		if de is not None and de.text != self._DE_TEXT:
			de.text = self._DE_TEXT
		panel = comp.op('panel1')
		if panel is not None:
			sel = panel.par.select.eval()
			if ('rselect' not in sel or 'wheel' not in sel
					or 'insideu' not in sel or 'shift' not in sel):
				panel.par.select = ('u v insideu insidev lselect rselect'
									' inside wheel shift ctrl alt')
		ce = comp.op('chopexec_mouse')
		if ce is not None and ce.text != self._CE_TEXT:
			ce.text = self._CE_TEXT
		try:
			kb = comp.op('keyboardin1')
			if kb is None:
				kb = comp.create(keyboardinDAT, 'keyboardin1')
				kb.nodeX, kb.nodeY = -420, -100
			kb.par.active = True
			try:
				kb.par.panels = '..'
			except Exception:
				pass
			cb = comp.op('keyboardin1_callbacks')
			if cb is None:
				cb = comp.create(textDAT, 'keyboardin1_callbacks')
				cb.nodeX, cb.nodeY = -420, -250
			if kb.par.callbacks.eval() != cb:
				kb.par.callbacks = 'keyboardin1_callbacks'
			if cb.text != self._KB_TEXT:
				cb.text = self._KB_TEXT
		except Exception as e:
			debug('TableEditor: keyboardin setup failed: %s' % e)
		# selection outputs: sel_rows/sel_cells tables -> outDATs give the
		# comp Lister-style DAT out connectors (out1 = rows, out2 = cells)
		try:
			for i, (tname, oname, y) in enumerate(
					(('sel_rows', 'out_selrows', -400),
					 ('sel_cells', 'out_selcells', -550))):
				tbl = comp.op(tname)
				if tbl is None:
					tbl = comp.create(tableDAT, tname)
					tbl.nodeX, tbl.nodeY = 680, y
					tbl.clear()
				out = comp.op(oname)
				if out is None:
					out = comp.create(outDAT, oname)
					out.nodeX, out.nodeY = 900, y
				if not out.inputs:
					out.inputConnectors[0].connect(tbl)
		except Exception as e:
			debug('TableEditor: selection outputs setup failed: %s' % e)

	# ---- target ---------------------------------------------------------------

	def _target(self):
		try:
			t = self.ownerComp.par.Targetop.eval()
		except Exception:
			return None
		if t is None or not t.valid or not t.isDAT:
			return None
		return t

	def _editable(self, dat):
		"""TD's own viewer rule: a DAT with inputs or a lock is view-only.
		The python attribute is OP.lock (verified live 2025.32820 —
		.locked does not exist on tableDAT)."""
		try:
			return not dat.inputs and not getattr(dat, 'lock', False)
		except Exception:
			return False

	def _read(self, dat):
		if dat is None:
			return None
		try:
			return [[c.val for c in dat.row(r)] for r in range(dat.numRows)]
		except Exception:
			return None

	def OnTargetChange(self):
		dat = self._target()
		de = self.ownerComp.op('datexec_target')
		if de is not None:
			try:
				de.par.dat = dat.path if dat is not None else ''
			except Exception:
				pass
		self._snap = self._read(dat)
		self._syncColDef()      # fully define colDefine for the new target
		self.OnSelection(None)  # selection coords from the old table are stale
		self._broadcastTable()
		self._callback('onTargetChange',
					   {'path': dat.path if dat is not None else ''})

	def Refresh(self):
		"""Re-snapshot and rebroadcast (Refresh pulse / Headerrow change)."""
		self._snap = self._read(self._target())
		self._broadcastTable()

	def ResetConfig(self):
		"""Resetconfig pulse: wipe the editor back to its zero-config/auto
		state for the current target. Clears the colDefine UI columns back
		to the empty property skeleton, tells clients to drop their saved
		view state (widths/formats/hidden), then re-broadcasts so the grid
		re-derives auto widths/formats straight from the table."""
		cd = self._colDef()
		if cd is not None:
			cd.clear()
			for rname in self._COLDEF_ROWS:
				cd.appendRow([rname])
		self._syncColDef()      # regenerate fresh default entries (auto)
		dat = self._target()
		self._broadcast({'t': 'resetview',
						 'path': dat.path if dat is not None else ''})
		self.Refresh()

	def Open(self, path):
		"""Retarget to a DAT path and pop the viewer window — the hook for
		a ctrl.t-style keyboard macro (the ListerUI workflow)."""
		try:
			self.ownerComp.par.Targetop = str(path)
		except Exception as e:
			debug('TableEditor: Open(%r) failed: %s' % (path, e))
		self.OpenWindow()

	def OpenWindow(self):
		w = self.ownerComp.op('window1')
		if w is not None:
			try:
				w.par.winopen.pulse()
			except Exception as e:
				debug('TableEditor: window open failed: %s' % e)

	def ReloadClients(self):
		"""Force every connected page to reload (fresh js/css from disk).
		The recovery for stale pages — e.g. a webrender that loaded before
		a repo update and ignores newer protocol messages."""
		self._broadcast({'t': 'reload'})
		try:
			web = self.ownerComp.op('webrender1')
			if web is not None:
				# belt for a wedged page that never dispatches the WS msg
				web.executeJavaScript('location.reload()')
		except Exception:
			pass

	# ---- style ------------------------------------------------------------------

	def _hex(self, name):
		try:
			vals = [getattr(self.ownerComp.par, name + ch).eval()
					for ch in 'rgb']
			return '#%02x%02x%02x' % tuple(
				max(0, min(255, int(round(v * 255)))) for v in vals)
		except Exception:
			return None

	def _styleDict(self):
		comp = self.ownerComp
		style = {}
		for parName, key in (
				('Bgcolor', 'bg'), ('Panelcolor', 'panel'),
				('Cellcolor', 'cell'), ('Cellaltcolor', 'cellalt'),
				('Gridcolor', 'grid'), ('Headercolor', 'header'),
				('Guttercolor', 'gutter'), ('Textcolor', 'text'),
				('Textdimcolor', 'textdim'), ('Accentcolor', 'accent'),
				('Highlightcolor', 'highlight')):
			h = self._hex(parName)
			if h:
				style[key] = h
		try:
			font = comp.par.Fontfamily.eval().strip()
			if font:
				style['font'] = font
			style['fontsize'] = int(comp.par.Fontsize.eval())
			style['rowh'] = int(comp.par.Rowheight.eval())
		except Exception:
			pass
		try:
			# not styling, but rides the same broadcast: footer action log
			style['showlog'] = bool(comp.par.Displaylog.eval())
		except Exception:
			pass
		return style

	def ApplyTheme(self, name):
		"""Write a preset's colors into the Style pars ('custom' = no-op);
		each write fires OnStyleChange, which coalesces to one broadcast."""
		theme = self._THEMES.get(name)
		if not theme:
			return
		for parName, rgb in theme.items():
			try:
				for ch, v in zip('rgb', rgb):
					getattr(self.ownerComp.par, parName + ch).val = v
			except Exception:
				pass

	def OnStyleChange(self):
		if self._styleQueued:
			return
		self._styleQueued = True
		run('args[0]._FlushStyle()', self, delayFrames=2,
			fromOP=self.ownerComp)

	def _FlushStyle(self):
		self._styleQueued = False
		self._broadcast({'t': 'style', 'style': self._styleDict()})

	# ---- outgoing: table state -> clients --------------------------------------

	def _tableMsg(self):
		dat = self._target()
		uicols, uivals = self._uiPayload()
		return {
			't': 'table',
			'rev': self.rev,
			'path': dat.path if dat is not None else '',
			'name': dat.name if dat is not None else '',
			'editable': bool(dat is not None and self._editable(dat)),
			'headerRow': bool(self.ownerComp.par.Headerrow.eval()),
			'style': self._styleDict(),
			'uicols': uicols,
			'uivals': uivals,
			'cells': self._snap if self._snap is not None else [],
		}

	def _broadcastTable(self):
		self.rev += 1
		msg = self._tableMsg()
		msg['rev'] = self.rev
		self._broadcast(msg)

	def OnTableChange(self):
		"""datexec_target fired: the target table cooked or was written.
		Our own writes already updated the snapshot, so equality means
		self-echo — skip. Same shape diffs to a cell delta; shape changes
		rebroadcast the full table."""
		dat = self._target()
		new = self._read(dat)
		old = self._snap
		if new == old:
			return
		self._snap = new
		if (old is not None and new is not None and len(old) == len(new)
				and len(old) > 0 and len(old[0]) == len(new[0])):
			edits = [{'r': r, 'c': c, 'v': new[r][c]}
					 for r in range(len(new))
					 for c in range(len(new[r]))
					 if old[r][c] != new[r][c]]
			if not edits:
				return
			self.rev += 1
			self._broadcast({'t': 'delta', 'rev': self.rev, 'edits': edits})
		else:
			self._broadcastTable()

	def _sendTo(self, client, msgDict):
		try:
			self.webserver.webSocketSendText(client, json.dumps(msgDict))
		except Exception:
			self.clients.discard(client)

	def _broadcast(self, msgDict):
		if self.clients:
			msg = json.dumps(msgDict)
			for client in list(self.clients):
				try:
					self.webserver.webSocketSendText(client, msg)
				except Exception:
					self.clients.discard(client)
		self._kickWebrender()

	# Offscreen CEF stops dispatching WS messages to the page once its
	# message stream goes quiet (verified in the sibling repo, 2025.32820/
	# CEF 132). A DOM-mutating executeJavaScript with forced layout revives
	# the renderer, so we kick after every broadcast.

	_KICK_JS = ("window.__inTD=true;"
				"document.documentElement.style.setProperty('--td-kick','%d');"
				"void document.documentElement.offsetHeight;")

	def _kickWebrender(self):
		try:
			web = self.ownerComp.op('webrender1')
			if web is None:
				return
			self._kickN += 1
			web.executeJavaScript(self._KICK_JS % self._kickN)
		except Exception:
			pass  # comp may be mid-rebuild; the next kick will land

	# ---- incoming: websocket -> table writes ------------------------------------

	def OnWSOpen(self, client):
		self.clients.add(client)
		self._sendTo(client, self._tableMsg())

	def OnWSClose(self, client):
		self.clients.discard(client)

	def OnWSText(self, client, data):
		try:
			msg = json.loads(data)
		except Exception:
			return
		t = msg.get('t')
		try:
			if t == 'hello':
				self.OnWSOpen(client)
			elif t == 'edit':
				self._applyEdits(msg.get('edits') or [])
			elif t == 'insertrows':
				self._insertRows(int(msg.get('at', 0)), msg.get('rows') or [])
			elif t == 'deleterows':
				self._deleteRows(msg.get('rows') or [])
			elif t == 'moverows':
				self._moveRows(msg.get('rows') or [], int(msg.get('to', 0)))
			elif t == 'insertcols':
				self._insertCols(int(msg.get('at', 0)),
								 int(msg.get('count', 1)))
			elif t == 'deletecols':
				self._deleteCols(msg.get('cols') or [])
			elif t == 'movecols':
				self._moveCols(msg.get('cols') or [], int(msg.get('to', 0)))
			elif t == 'reorder':
				self._reorderRows(msg.get('rows') or [])
			elif t == 'replace':
				self._replaceCells(msg.get('cells') or [])
			elif t == 'sel':
				self.OnSelection(msg.get('sel'))
			elif t == 'clip':
				ui.clipboard = str(msg.get('text', ''))
			elif t == 'getclip':
				# clipboard pull: page menus (insert clipboard rows) ask
				# for ui.clipboard — the OS clipboard, CEF-safe
				self._sendTo(client, {'t': 'clip',
									  'text': str(ui.clipboard or '')})
			elif t == 'refresh':
				self.Refresh()
			elif t == 'button':
				# clickable cell (button-format column or any virtual UI
				# column). Hand the callback the FULL row (hidden columns
				# included) so it can reach its target. Dispatch precedence:
				# onClick<Column> (named) -> onButtonClick -> onClick.
				self._dispatchClick(
					self._clickInfo(int(msg.get('r', -1)),
									int(msg.get('c', -1)),
									str(msg.get('col', ''))),
					allowButtonAlias=True)
			elif t == 'click':
				# universal Lister-style click on ANY cell. Precedence:
				# onClick<Column> (named) -> onClick (universal).
				self._dispatchClick(
					self._clickInfo(int(msg.get('r', -1)),
									int(msg.get('c', -1)),
									str(msg.get('col', ''))),
					allowButtonAlias=False)
			elif t == 'setcoldef':
				# page menus / column-settings wizard write the config
				self._setColDef(msg.get('defs') or [])
				self.Refresh()
			elif t == 'cursor':
				# offscreen CEF can't change the OS cursor — the page
				# reports the CSS cursor under the pointer and we map it
				# onto the container's cursor par
				self._setCursor(str(msg.get('name', '')))
			elif t == 'openpars':
				# toolbar gear: pop the comp's parameter dialog in TD
				self.ownerComp.openParameters()
			elif t == 'setheader':
				old = bool(self.ownerComp.par.Headerrow.eval())
				new = bool(msg.get('on'))
				if old != new:
					self.ownerComp.par.Headerrow = new
					self._registerUndo('Table header toggle',
						{'kind': 'par', 'path': self.ownerComp.path,
						 'name': 'Headerrow', 'undo': old, 'redo': new})
				# parexec valuechange fires Refresh -> broadcast
			elif t == 'settable':
				self.ownerComp.par.Targetop = str(msg.get('path', ''))
			if t in ('insertrows', 'deleterows', 'moverows', 'insertcols',
					 'deletecols', 'movecols', 'reorder', 'replace'):
				self._callback('onStructure', {'kind': t, 'msg': msg})
		except Exception as e:
			debug('TableEditor: %s failed: %s' % (t, e))
			self._sendTo(client, {'t': 'error', 'msg': '%s: %s' % (t, e)})

	def _editTarget(self):
		dat = self._target()
		if dat is None or not self._editable(dat):
			return None
		return dat

	# ---- colDefine: configured UI columns (Lister's colDefine model) -------
	# Rows are properties, data columns are UI columns. An entry whose
	# `source` names a table column overrides that column's look; an entry
	# without `source` is a VIRTUAL column appended after the table columns
	# (button/thumb/eval content). `expr` evaluates per data row TD-side
	# with `cells` (dict by column name), `row`, `op`, `me` in scope.

	_COLDEF_ROWS = ('column', 'label', 'source', 'mode', 'expr', 'icon',
					'visible', 'width', 'editable')

	def _colDef(self):
		par = getattr(self.ownerComp.par, 'Coldefine', None)
		return par.eval() if par is not None else None

	def _colNames(self):
		"""Source-table column names: header row if Headerrow, else c0..cN."""
		snap = self._snap or []
		ncols = len(snap[0]) if snap else 0
		if ncols and bool(self.ownerComp.par.Headerrow.eval()):
			return [str(v) for v in snap[0]]
		return ['c%d' % i for i in range(ncols)]

	def _uiColsSpec(self):
		"""Parse the colDefine DAT -> list of UI column dicts (or [])."""
		cd = self._colDef()
		if cd is None or cd.numCols < 2 or cd.numRows < 1:
			return []
		rowIdx = {}
		for r in range(cd.numRows):
			rowIdx[cd[r, 0].val.strip()] = r
		if 'column' not in rowIdx:
			return []
		names = self._colNames()
		defs = []
		for c in range(1, cd.numCols):
			def cell(prop, dv=''):
				r = rowIdx.get(prop)
				return cd[r, c].val.strip() if r is not None else dv
			name = cell('column')
			if not name:
				continue
			source = cell('source')
			if source and source not in names:
				# accumulated entry for a column not in THIS target —
				# keep it in the DAT but don't render it (per-target hide)
				continue
			d = {
				'name': name,
				'label': cell('label') or '*',
				'src': names.index(source) if (source and source in names) else -1,
				'mode': cell('mode') or 'text',
				'expr': cell('expr'),
				'icon': cell('icon'),
				'visible': cell('visible') not in ('0', 'false'),
				'width': cell('width'),
				'editable': cell('editable') not in ('0', 'false'),
			}
			if d['label'] == '*':
				d['label'] = name
			defs.append(d)
		return defs

	def _uiVals(self, defs):
		"""Evaluate expr-bearing UI columns per data row -> {name: [vals]}
		(list aligned to DAT rows; header row evaluates to '')."""
		out = {}
		snap = self._snap or []
		if not snap:
			return out
		names = self._colNames()
		head = 1 if bool(self.ownerComp.par.Headerrow.eval()) else 0
		comp = self.ownerComp
		for d in defs:
			if not d['expr']:
				continue
			try:
				code = compile(d['expr'], '<colDefine:%s>' % d['name'], 'eval')
			except Exception as e:
				debug('TableEditor: colDefine expr %s: %s' % (d['name'], e))
				continue
			vals = []
			for r, rowVals in enumerate(snap):
				if r < head:
					vals.append('')
					continue
				cells = {n: (rowVals[i] if i < len(rowVals) else '')
						 for i, n in enumerate(names)}
				try:
					v = eval(code, {'op': op, 'me': comp, 'tdu': tdu,
									'cells': cells, 'row': r})
				except Exception:
					v = ''
				vals.append(str(v) if v is not None else '')
			out[d['name']] = vals
		return out

	def _uiPayload(self):
		"""(uicols, uivals) for broadcasts — ({}, {}) when unconfigured."""
		defs = self._uiColsSpec()
		if not defs:
			return [], {}
		return defs, self._uiVals(defs)

	def _syncColDef(self):
		"""Fully define colDefine for the current target: every table column
		gets an entry (source = its name, auto defaults), ordered to match the
		target. ACCUMULATE — entries whose source is not in this target are
		kept (hidden by _uiColsSpec), never removed; virtual columns (no
		source) are preserved after the table columns. Idempotent."""
		cd = self._colDef()
		if cd is None:
			return
		names = self._colNames()
		if not names:
			return
		if cd.numRows < 1 or cd[0, 0].val.strip() != 'column':
			cd.clear()
			for rname in self._COLDEF_ROWS:
				cd.appendRow([rname])
		rowIdx = {cd[r, 0].val.strip(): r for r in range(cd.numRows)}
		for prop in self._COLDEF_ROWS:
			if prop not in rowIdx:
				cd.appendRow([prop])
				rowIdx[prop] = cd.numRows - 1
		entries = []
		for c in range(1, cd.numCols):
			e = {pr: cd[rowIdx[pr], c].val for pr in self._COLDEF_ROWS}
			if e.get('column', '').strip():
				entries.append(e)
		bySource = {}
		for e in entries:
			src = e.get('source', '').strip()
			if src and src not in bySource:
				bySource[src] = e
		used = set()
		usedCols = set()
		ordered = []
		# 1) target columns, in target order: existing entry (matched by
		# source) or a new default — at most one entry per column name
		for n in names:
			if not n.strip() or n in usedCols:
				continue        # unnamed or already-added table column
			e = bySource.get(n)
			ecol = e.get('column', '').strip() if e is not None else ''
			if e is not None and id(e) not in used and ecol and ecol not in usedCols:
				ordered.append(e)
				used.add(id(e))
				usedCols.add(ecol)
			else:
				ordered.append({'column': n, 'label': '', 'source': n,
								'mode': 'text', 'expr': '', 'icon': '',
								'visible': '1', 'width': '', 'editable': '1'})
				usedCols.add(n)
		# 2) accumulated (source not in target) + virtuals — unique column
		# names only; drop a duplicate override of a table column
		for e in entries:
			if id(e) in used:
				continue
			src = e.get('source', '').strip()
			if src and src in names:
				continue        # duplicate override of a table column
			col = e.get('column', '').strip()
			if col and col not in usedCols:
				ordered.append(e)
				used.add(id(e))
				usedCols.add(col)
		# rewrite entry columns in the computed order (keep property col 0)
		while cd.numCols > 1:
			cd.deleteCol(cd.numCols - 1)
		for e in ordered:
			cd.appendCol([''] * cd.numRows)
			col = cd.numCols - 1
			for pr in self._COLDEF_ROWS:
				cd[rowIdx[pr], col] = str(e.get(pr, ''))

	def _setColDef(self, entries):
		"""Write entries [{column, set:{prop: value}}] into the colDefine
		DAT (creates the DAT shape, property rows and columns as needed) —
		the page menus/wizard edit the config through this."""
		cd = self._colDef()
		if cd is None:
			return
		if cd.numRows < 1 or cd[0, 0].val.strip() != 'column':
			cd.clear()
			for rname in self._COLDEF_ROWS:
				cd.appendRow([rname])
		rowIdx = {cd[r, 0].val.strip(): r for r in range(cd.numRows)}
		for prop in self._COLDEF_ROWS:
			if prop not in rowIdx:
				cd.appendRow([prop])
				rowIdx[prop] = cd.numRows - 1
		for e in entries:
			name = str(e.get('column', '')).strip()
			if not name:
				continue
			col = None
			for c in range(1, cd.numCols):
				if cd[rowIdx['column'], c].val.strip() == name:
					col = c
					break
			vals = e.get('set')
			if vals is None:          # no props -> delete the entry
				if col is not None:
					cd.deleteCol(col)
				continue
			if col is None:
				cd.appendCol([''] * cd.numRows)
				col = cd.numCols - 1
				cd[rowIdx['column'], col] = name
			for prop, v in vals.items():
				if prop in rowIdx:
					cd[rowIdx[prop], col] = str(v)

	def _hasCallback(self, name):
		try:
			dat = self.ownerComp.par.Callbackdat.eval()
			return dat is not None and getattr(dat.module, name, None) is not None
		except Exception:
			return False

	def _clickInfo(self, r, c, colName):
		"""Build the click callback info: row, col, column name, the FULL
		row (cells), and cellsByName. Resolves an empty column name from
		the DAT column index."""
		cells = (list(self._snap[r]) if self._snap is not None
				 and 0 <= r < len(self._snap) else [])
		names = self._colNames()
		if not colName and 0 <= c < len(names):
			colName = names[c]
		return {'row': r, 'col': c, 'column': colName, 'cells': cells,
				'cellsByName': {n: (cells[i] if i < len(cells) else '')
								for i, n in enumerate(names)}}

	def _dispatchClick(self, info, allowButtonAlias):
		"""One click dispatch for buttons, virtual cells and plain cells.
		Precedence: onClick<Column> (named) -> onButtonClick (only for
		button/virtual clicks) -> onClick (universal catch-all)."""
		colName = info.get('column', '')
		named = ('onClick' + colName[:1].upper() + colName[1:]
				 if colName else '')
		if named and self._hasCallback(named):
			self._callback(named, info)
		elif allowButtonAlias and self._hasCallback('onButtonClick'):
			self._callback('onButtonClick', info)
		else:
			self._callback('onClick', info)

	def _callback(self, name, info):
		"""Lister-style user callbacks: resolve the Callbackdat par to a
		module and call `name(info)` if defined there. info always carries
		ownerComp and target. Errors are reported, never raised."""
		try:
			par = getattr(self.ownerComp.par, 'Callbackdat', None)
			dat = par.eval() if par is not None else None
			if dat is None:
				return
			fn = getattr(dat.module, name, None)
			if fn is None:
				return
			info = dict(info)
			info['ownerComp'] = self.ownerComp
			info['target'] = self._target()
			fn(info)
		except Exception as e:
			debug('TableEditor: callback %s failed: %s' % (name, e))

	def _registerUndo(self, name, info):
		"""One TD-native undo block per ext write (see _undoRestore)."""
		try:
			ui.undo.startBlock(name)
			ui.undo.addCallback(_undoRestore, info)
			ui.undo.endBlock()
		except Exception as e:
			debug('TableEditor: undo register failed: %s' % e)

	def _applyEdits(self, edits):
		dat = self._editTarget()
		if dat is None:
			return
		applied = []
		old = []
		for e in edits:
			r, c = int(e.get('r', -1)), int(e.get('c', -1))
			v = str(e.get('v', ''))
			if 0 <= r < dat.numRows and 0 <= c < dat.numCols:
				old.append((r, c, dat[r, c].val))
				dat[r, c] = v
				if self._snap is not None:
					self._snap[r][c] = v
				applied.append({'r': r, 'c': c, 'v': v})
		if applied:
			self._registerUndo('Table edit: %s' % dat.name,
				{'kind': 'edit', 'path': dat.path, 'undo': old,
				 'redo': [(a['r'], a['c'], a['v']) for a in applied]})
			self.rev += 1
			self._broadcast({'t': 'delta', 'rev': self.rev, 'edits': applied})
			# expr-bearing UI columns may depend on the edited cells
			defs = self._uiColsSpec()
			if any(d['expr'] for d in defs):
				self._broadcast({'t': 'uivals', 'vals': self._uiVals(defs)})
			self._callback('onEdit', {'edits': applied, 'prev': old})

	# Structural ops transform the snapshot in Python and rewrite the DAT
	# wholesale (clear + appendRow): version-proof vs uncertain
	# insertRow/deleteRow APIs, and a single datexec fire. Revisit for very
	# large tables (sprintboard M2).

	def _rewrite(self, cells):
		dat = self._editTarget()
		if dat is None:
			return
		pre = self._read(dat)
		self._snap = cells
		ok = True
		try:
			dat.clear()
			for row in cells:
				dat.appendRow(row)
		except Exception as e:
			debug('TableEditor: rewrite failed: %s' % e)
			self._snap = self._read(dat)
			ok = False
		if ok:
			self._registerUndo('Table rewrite: %s' % dat.name,
				{'kind': 'table', 'path': dat.path, 'undo': pre,
				 'redo': [list(r) for r in cells]})
		self._broadcastTable()

	def _cellsCopy(self):
		"""Working copy for structural ops — read the live DAT, not the
		snapshot. TD is the source of truth: a stale snapshot (e.g. a
		datexec fire coalesced away) must never be written back over
		the table."""
		dat = self._target()
		if dat is not None:
			return self._read(dat)
		return [list(r) for r in (self._snap or [])]

	def _numCols(self, cells):
		return len(cells[0]) if cells else 0

	def _insertRows(self, at, rows):
		cells = self._cellsCopy()
		ncols = self._numCols(cells) or (max((len(r) for r in rows),
											 default=1))
		at = max(0, min(at, len(cells)))
		block = []
		for r in rows:
			row = [str(v) for v in (r or [])][:ncols]
			row += [''] * (ncols - len(row))
			block.append(row)
		if not block:
			block = [[''] * ncols]
		self._rewrite(cells[:at] + block + cells[at:])

	def _deleteRows(self, rows):
		cells = self._cellsCopy()
		drop = {int(r) for r in rows if 0 <= int(r) < len(cells)}
		if not drop or len(drop) >= len(cells):
			return  # never delete the last row(s) to an empty table
		self._rewrite([r for i, r in enumerate(cells) if i not in drop])

	def _moveRows(self, rows, to):
		cells = self._cellsCopy()
		take = sorted({int(r) for r in rows if 0 <= int(r) < len(cells)})
		if not take:
			return
		block = [cells[i] for i in take]
		rest = [r for i, r in enumerate(cells) if i not in set(take)]
		# 'to' is in pre-removal coords: adjust for taken rows above it
		ins = max(0, min(to - sum(1 for i in take if i < to), len(rest)))
		self._rewrite(rest[:ins] + block + rest[ins:])

	def _insertCols(self, at, count):
		cells = self._cellsCopy()
		if not cells:
			cells = [['']]
		ncols = self._numCols(cells)
		at = max(0, min(at, ncols))
		count = max(1, count)
		self._rewrite([r[:at] + [''] * count + r[at:] for r in cells])

	def _deleteCols(self, cols):
		cells = self._cellsCopy()
		ncols = self._numCols(cells)
		drop = {int(c) for c in cols if 0 <= int(c) < ncols}
		if not drop or len(drop) >= ncols:
			return
		self._rewrite([[v for i, v in enumerate(r) if i not in drop]
					   for r in cells])

	def _replaceCells(self, cells):
		"""Whole-table rewrite — the client undo/redo path for structural
		ops (the inverse of insert/delete/move is a snapshot restore)."""
		norm = [[str(v) for v in row] for row in cells]
		if norm:
			self._rewrite(norm)

	def _reorderRows(self, rows):
		"""Apply a full data-row permutation (the page's 'Apply sort to
		DAT'). Header rows keep their place; rows missing from the list
		(raced concurrent edits) append at the end in original order."""
		cells = self._cellsCopy()
		hdr = 1 if self.ownerComp.par.Headerrow.eval() else 0
		hdr = min(hdr, len(cells))
		valid = []
		seen = set()
		for r in rows:
			r = int(r)
			if hdr <= r < len(cells) and r not in seen:
				valid.append(r)
				seen.add(r)
		if not valid:
			return
		missing = [i for i in range(hdr, len(cells)) if i not in seen]
		self._rewrite(cells[:hdr] + [cells[r] for r in valid]
					  + [cells[i] for i in missing])

	def _moveCols(self, cols, to):
		cells = self._cellsCopy()
		ncols = self._numCols(cells)
		take = sorted({int(c) for c in cols if 0 <= int(c) < ncols})
		if not take:
			return
		ins = max(0, min(to - sum(1 for i in take if i < to), ncols - len(take)))
		out = []
		for r in cells:
			block = [r[i] for i in take]
			rest = [v for i, v in enumerate(r) if i not in set(take)]
			out.append(rest[:ins] + block + rest[ins:])
		self._rewrite(out)

	# ---- selection outputs (Lister-style) ----------------------------------------

	def OnSelection(self, sel):
		"""Mirror the page's selection into the comp's sel_rows / sel_cells
		table DATs (wired to the comp's DAT out connectors). Last client to
		change selection wins. sel: {rows:[datRow,..], c0, c1} or None."""
		rowsDat = self.ownerComp.op('sel_rows')
		cellsDat = self.ownerComp.op('sel_cells')
		if rowsDat is None or cellsDat is None:
			return
		try:
			rowsDat.clear()
			cellsDat.clear()
			if not sel or self._snap is None:
				return
			rows = [int(r) for r in (sel.get('rows') or [])
					if 0 <= int(r) < len(self._snap)]
			c0 = max(0, int(sel.get('c0', 0)))
			c1 = int(sel.get('c1', 0))
			for r in rows:
				rowsDat.appendRow(self._snap[r])
				cellsDat.appendRow(self._snap[r][c0:c1 + 1])
			self._callback('onSelect', {'rows': rows, 'c0': c0, 'c1': c1})
		except Exception as e:
			debug('TableEditor: selection mirror failed: %s' % e)

	# ---- in-TD input forwarding (webrenderTOP has no native key injection) ------

	# CSS cursor name -> containerCOMP cursor par menu value
	_CURSOR_MAP = {
		'default': 'pointer', 'auto': 'pointer', 'pointer': 'linkselect',
		'text': 'ibeam', 'cell': 'cross', 'crosshair': 'cross',
		'col-resize': 'arrowLeftRight', 'ew-resize': 'arrowLeftRight',
		'row-resize': 'arrowUpDown', 'ns-resize': 'arrowUpDown',
		'move': 'arrowAll', 'grab': 'arrowAll', 'grabbing': 'arrowAll',
	}

	def _setCursor(self, name):
		want = self._CURSOR_MAP.get(name, 'pointer')
		try:
			if self.ownerComp.par.cursor.eval() != want:
				self.ownerComp.par.cursor = want
		except Exception:
			pass

	_WHEEL_SCALE = 1  # panel wheel notches map 1:1 to interactMouse wheel

	def OnModifierKey(self, key, state):
		"""Track in-TD modifier state. Source is keyboardin (modifier keys
		arrive as their own key events, both keydown and keyup) plus any
		panel CHOP modifier channel transitions. Pushed to the page on
		change as window.__tdMods — interactMouse events carry no
		modifier flags, so the grid merges this at pointerdown."""
		k = str(key)
		for fam in ('shift', 'ctrl', 'alt', 'cmd'):
			if k.endswith(fam):
				if self._mods.get(fam) != bool(state):
					self._mods[fam] = bool(state)
					self._pushMods()
				return

	def SyncMods(self, shift, ctrl, alt, cmd):
		"""Resync from the chord flags carried on every regular key event —
		recovers from a modifier keyup missed while the panel lacked
		keyboard focus."""
		want = {'shift': bool(shift), 'ctrl': bool(ctrl),
				'alt': bool(alt), 'cmd': bool(cmd)}
		if want != self._mods:
			self._mods = want
			self._pushMods()

	def _pushMods(self):
		web = self.ownerComp.op('webrender1')
		if web is None:
			return
		try:
			web.executeJavaScript(
				'window.__tdMods = %s' % json.dumps(self._mods))
		except Exception:
			pass

	def ForwardWheel(self, u, v, displace, shift=False):
		if not displace:
			return
		try:
			web = self.ownerComp.op('webrender1')
			if web is None:
				return
			if shift or self._mods.get('shift'):
				# interactMouse wheel is vertical-only; shift+wheel scrolls
				# the grid horizontally via an injected page hook
				web.executeJavaScript(
					'window.__tdHWheel && window.__tdHWheel(%f)' % displace)
				return
			web.interactMouse(u, v, wheel=displace * self._WHEEL_SCALE)
		except Exception:
			pass

	def ForwardKey(self, key, character, shift, ctrl=False, alt=False,
				   cmd=False):
		"""Inject a TD keystroke into the page (webrenderTOP has no native
		keyboard injection). Ctrl/cmd+c/x/v route the clipboard through TD —
		offscreen CEF has no OS clipboard access, ui.clipboard does. ctrl,
		alt and cmd travel separately so the page can keep mac semantics
		(alt=word jump, cmd=line start/end) apart from ctrl chords."""
		web = self.ownerComp.op('webrender1')
		if web is None:
			return
		try:
			if (ctrl or cmd) and str(key) in ('c', 'x', 'v'):
				if key == 'v':
					text = ui.clipboard or ''
					web.executeJavaScript(
						'window.__tdPaste && window.__tdPaste(%s)'
						% json.dumps(text))
				else:
					web.executeJavaScript(
						'window.__tdCopy && window.__tdCopy(%s)'
						% ('true' if key == 'x' else 'false'))
				return
			payload = json.dumps({'key': str(key or ''),
								  'ch': str(character or ''),
								  'shift': bool(shift),
								  'ctrl': bool(ctrl),
								  'alt': bool(alt),
								  'cmd': bool(cmd)})
			web.executeJavaScript(
				'window.__tdKey && window.__tdKey(%s)' % payload)
		except Exception:
			pass

	def ForwardMouse(self, u, v, iu, iv, left, inside, right=0):
		"""Panel u/v only track during left interactions; insideu/insidev
		track rollover — left drags use u/v, hover and right-clicks use the
		inside pair (see the sibling repo's CLAUDE.md)."""
		if left:
			px, py = u, v
		elif inside:
			px, py = iu, iv
		elif right:
			px, py = u, v
		else:
			return
		web = self.ownerComp.op('webrender1')
		try:
			web.interactMouse(px, py, left=bool(left), right=bool(right))
		except Exception:
			pass
