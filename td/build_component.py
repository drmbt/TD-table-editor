"""
build_component.py — run inside TouchDesigner (textport: exec(open(path).read()))

Builds /project1/TableEditor idempotently: webserverDAT + webrenderTOP +
file-synced extension/callbacks DATs + a demo cue-sheet table + popup
window. Targets TD 2025.x. Patterns inherited from TD-WEBgui-controller's
builder (verified there against 2025.32820 / CEF 132):

  * creating a webserverDAT auto-creates a template '<name>_callbacks' DAT —
    we destroy it and point par.callbacks at our file-synced DAT
  * webrenderTOP par.active defaults OFF and outputresolution defaults
    'useinput'; both must be set or the Chromium process never starts
  * callback DAT texts are canonical in TableEditorExt._ensureSetup();
    this script creates bare DATs only
"""

import os

REPO = os.path.expanduser('~/Documents/github/TD-table-editor')
PORT = 9981
PARENT = '/project1'
NAME = 'TableEditor'


def build():
	root = op(PARENT)
	old = root.op(NAME)
	if old:
		old.destroy()

	comp = root.create(containerCOMP, NAME)
	comp.viewer = True

	# ---- custom pars -------------------------------------------------------
	page = comp.appendCustomPage('Table Editor')
	page.appendOP('Targetop', label='Target Table DAT')
	p = page.appendToggle('Headerrow', label='First Row Is Header')[0]
	p.default = p.val = True
	p = page.appendStr('Webroot', label='Web Root Folder')[0]
	p.val = REPO + '/web'
	p = page.appendInt('Port', label='Port')[0]
	p.normMin, p.normMax, p.val = 1024, 65535, PORT
	page.appendPulse('Refresh', label='Refresh From Target')
	page.appendPulse('Openviewer', label='Open Viewer Window')
	page.appendPulse('Openinbrowser', label='Open In Browser')

	# ---- file-synced DATs ---------------------------------------------------
	def fileDAT(name, path):
		d = comp.create(textDAT, name)
		d.par.file = path
		d.par.syncfile = True
		d.par.loadonstartpulse.pulse()
		return d

	fileDAT('TableEditorExt', REPO + '/td/TableEditorExt.py')

	# ---- demo target: a cue-sheet table -------------------------------------
	demo = comp.create(tableDAT, 'demo_table')
	demo.clear()
	demo.appendRow(['cue', 'name', 'duration', 'color', 'notes'])
	rows = [
		['1', 'Doors', '1800', 'cyan', 'walk-in loop'],
		['2', 'Intro', '120', 'magenta', 'strobe warning'],
		['3', 'Drop A', '45', 'red', ''],
		['4', 'Breakdown', '90', 'amber', 'haze 50%'],
		['5', 'Drop B', '60', 'red', 'blinders'],
		['6', 'Outro', '180', 'blue', 'slow fade'],
	]
	for r in rows:
		demo.appendRow(r)

	# ---- webserver (TD auto-creates webserver1_callbacks template) ----------
	ws = comp.create(webserverDAT, 'webserver1')
	tmpl = comp.op('webserver1_callbacks')
	if tmpl:
		tmpl.destroy()
	fileDAT('webserver1_callbacks', REPO + '/td/webserver_callbacks.py')
	ws.par.callbacks = 'webserver1_callbacks'
	ws.par.port = PORT
	ws.par.active = True

	# ---- extension -----------------------------------------------------------
	comp.par.extension1 = "op('./TableEditorExt').module.TableEditorExt(me)"
	comp.par.promoteextension1 = True

	# ---- parexec: the comp's own pars (text canonical in _ensureSetup) -------
	pe2 = comp.create(parameterexecuteDAT, 'parexec_self')
	pe2.par.op = '..'
	pe2.par.custom = True
	pe2.par.onpulse = True
	pe2.par.valuechange = True

	# ---- datexec: watches the target table (dat set by ext.OnTargetChange) ---
	de = comp.create(datexecuteDAT, 'datexec_target')
	de.par.tablechange = True

	# ---- webrender TOP --------------------------------------------------------
	web = comp.create(webrenderTOP, 'webrender1')
	web.par.url = 'http://127.0.0.1:%d/' % PORT
	web.par.active = True
	web.par.outputresolution = 'custom'
	web.par.resolutionw.expr = 'parent().width'
	web.par.resolutionh.expr = 'parent().height'
	web.par.maxrenderrate = 60
	web.par.autorestart = True

	info = comp.create(infoDAT, 'info_webrender')
	info.par.op = 'webrender1'

	# ---- panel shows the webrender; mouse forwarded into chromium -------------
	comp.par.w = 900
	comp.par.h = 600
	comp.par.top = './webrender1'
	comp.par.bgalpha = 1

	panel = comp.create(panelCHOP, 'panel1')
	panel.par.component = '..'
	# u/v track only while a button is held; insideu/insidev track rollover
	panel.par.select = 'u v insideu insidev lselect rselect inside wheel'

	# text filled by ext._ensureSetup() on reinit (canonical copy lives there)
	ce = comp.create(chopexecuteDAT, 'chopexec_mouse')
	ce.par.chop = 'panel1'
	ce.par.valuechange = True

	# ---- popup window (the ctrl.t / ListerUI-style workflow) -------------------
	win = comp.create(windowCOMP, 'window1')
	try:
		win.par.winop = '..'
		win.par.size = True
		win.par.winw = 900
		win.par.winh = 600
		win.par.borders = True
	except Exception as e:
		print('TableEditor: window par setup needs a live check:', e)

	# ---- layout the network -----------------------------------------------------
	grid = [
		('TableEditorExt', -200, 250), ('webserver1_callbacks', 20, 250),
		('parexec_self', 240, 250), ('datexec_target', 460, 250),
		('demo_table', 680, 250), ('webserver1', 20, 100),
		('panel1', -200, -100), ('chopexec_mouse', 0, -100),
		('webrender1', 240, -100), ('info_webrender', 460, -100),
		('window1', 680, -100),
	]
	for name, x, y in grid:
		o = comp.op(name)
		if o:
			o.nodeX, o.nodeY = x, y

	comp.par.Targetop = comp.op('demo_table')
	comp.par.reinitextensions.pulse()
	print('TableEditor built at %s — http://127.0.0.1:%d/' % (comp.path, PORT))
	return comp


build()
