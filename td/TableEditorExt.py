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
		self.OnTargetChange()

	@property
	def webserver(self):
		return self.ownerComp.op('webserver1')

	# ---- idempotent setup / migration --------------------------------------
	# Canonical copies of the in-comp callback DAT texts live here so repo
	# updates apply on reinitextensions (build_component creates bare DATs).

	_PE2_PARS = 'Targetop Headerrow Refresh Openinbrowser Openviewer'

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
		"\treturn\n"
		"\n"
		"def onValueChange(par, prev):\n"
		"\text = parent().ext.TableEditorExt\n"
		"\tif par.name == 'Targetop':\n"
		"\t\text.OnTargetChange()\n"
		"\telif par.name == 'Headerrow':\n"
		"\t\text.Refresh()\n"
		"\treturn\n")

	_DE_TEXT = (
		"def onTableChange(dat):\n"
		"\tparent().ext.TableEditorExt.OnTableChange()\n"
		"\treturn\n")

	_CE_TEXT = (
		"def onValueChange(channel, sampleIndex, val, prev):\n"
		"\tc = channel.owner\n"
		"\text = parent().ext.TableEditorExt\n"
		"\tif channel.name == 'wheel':\n"
		"\t\t# panel wheel is an instantaneous displacement (then snaps to 0)\n"
		"\t\text.ForwardWheel(float(c['insideu']), float(c['insidev']), val)\n"
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
		"\tif not keyInfo.state:\n"
		"\t\treturn\n"
		"\tparent().ext.TableEditorExt.ForwardKey(\n"
		"\t\tkeyInfo.key, keyInfo.character, keyInfo.shift)\n"
		"\treturn\n")

	def _ensureSetup(self):
		comp = self.ownerComp
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
					or 'insideu' not in sel):
				panel.par.select = ('u v insideu insidev lselect rselect'
									' inside wheel')
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
		self._broadcastTable()

	def Refresh(self):
		"""Re-snapshot and rebroadcast (Refresh pulse / Headerrow change)."""
		self._snap = self._read(self._target())
		self._broadcastTable()

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

	# ---- outgoing: table state -> clients --------------------------------------

	def _tableMsg(self):
		dat = self._target()
		return {
			't': 'table',
			'rev': self.rev,
			'path': dat.path if dat is not None else '',
			'name': dat.name if dat is not None else '',
			'editable': bool(dat is not None and self._editable(dat)),
			'headerRow': bool(self.ownerComp.par.Headerrow.eval()),
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

	_KICK_JS = ("document.documentElement.style.setProperty('--td-kick','%d');"
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
			elif t == 'setheader':
				self.ownerComp.par.Headerrow = bool(msg.get('on'))
				# parexec valuechange fires Refresh -> broadcast
			elif t == 'settable':
				self.ownerComp.par.Targetop = str(msg.get('path', ''))
		except Exception as e:
			debug('TableEditor: %s failed: %s' % (t, e))
			self._sendTo(client, {'t': 'error', 'msg': '%s: %s' % (t, e)})

	def _editTarget(self):
		dat = self._target()
		if dat is None or not self._editable(dat):
			return None
		return dat

	def _applyEdits(self, edits):
		dat = self._editTarget()
		if dat is None:
			return
		applied = []
		for e in edits:
			r, c = int(e.get('r', -1)), int(e.get('c', -1))
			v = str(e.get('v', ''))
			if 0 <= r < dat.numRows and 0 <= c < dat.numCols:
				dat[r, c] = v
				if self._snap is not None:
					self._snap[r][c] = v
				applied.append({'r': r, 'c': c, 'v': v})
		if applied:
			self.rev += 1
			self._broadcast({'t': 'delta', 'rev': self.rev, 'edits': applied})

	# Structural ops transform the snapshot in Python and rewrite the DAT
	# wholesale (clear + appendRow): version-proof vs uncertain
	# insertRow/deleteRow APIs, and a single datexec fire. Revisit for very
	# large tables (sprintboard M2).

	def _rewrite(self, cells):
		dat = self._editTarget()
		if dat is None:
			return
		self._snap = cells
		try:
			dat.clear()
			for row in cells:
				dat.appendRow(row)
		except Exception as e:
			debug('TableEditor: rewrite failed: %s' % e)
			self._snap = self._read(dat)
		self._broadcastTable()

	def _cellsCopy(self):
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

	# ---- in-TD input forwarding (webrenderTOP has no native key injection) ------

	_WHEEL_SCALE = 1  # panel wheel notches map 1:1 to interactMouse wheel

	def ForwardWheel(self, u, v, displace):
		if not displace:
			return
		try:
			web = self.ownerComp.op('webrender1')
			if web is None:
				return
			web.interactMouse(u, v, wheel=displace * self._WHEEL_SCALE)
		except Exception:
			pass

	def ForwardKey(self, key, character, shift):
		web = self.ownerComp.op('webrender1')
		if web is None:
			return
		payload = json.dumps({'key': str(key or ''),
							  'ch': str(character or ''),
							  'shift': bool(shift)})
		try:
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
