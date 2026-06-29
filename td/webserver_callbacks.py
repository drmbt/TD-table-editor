"""
webserverDAT callbacks for TableEditor.

HTTP: serves static files from the folder in the comp's Webroot par.
WebSocket: relays open/close/text to the TableEditorExt extension.
"""

import os
import re
import mimetypes


def _ext(webServerDAT):
	return webServerDAT.parent().ext.TableEditorExt


# CEF's offscreen renderer heuristically caches js/css subresources even
# with Cache-Control: no-cache, so a disk edit can keep serving stale code
# across reloads (verified the hard way). Stamp each local js/css ref in the
# served HTML with the asset's mtime so a changed file always busts the cache.
_ASSET_RE = re.compile(r'(src|href)="((?:js|css)/[^"?]+)"')


def _stampAssets(data, root):
	try:
		html = data.decode('utf-8')
	except Exception:
		return data

	def repl(m):
		attr, rel = m.group(1), m.group(2)
		try:
			v = int(os.path.getmtime(os.path.normpath(os.path.join(root, rel))))
		except Exception:
			return m.group(0)
		return '%s="%s?v=%d"' % (attr, rel, v)

	return _ASSET_RE.sub(repl, html).encode('utf-8')


_IMG_EXT = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
			'.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
			'.tif': 'image/tiff', '.tiff': 'image/tiff'}


def _thumb(webServerDAT, request, response):
	"""/thumb?src=<TOP path or image file path> — cell thumbnails for the
	'thumb' column format. TOPs render via saveByteArray; disk images are
	served as-is. Short max-age so cooking TOPs refresh without hammering."""
	pars = request.get('pars') or {}
	src = str(pars.get('src', '')).strip()
	if not src:
		uri = request.get('uri', '')
		if '?src=' in uri:               # builds that don't split params
			from urllib.parse import unquote
			src = unquote(uri.split('?src=', 1)[1].split('&')[0])
	data = None
	mime = 'image/png'
	if src.startswith('/') and op(src) is not None:
		o = op(src)
		if o.isTOP:
			try:
				data = bytes(o.saveByteArray('.png'))
			except Exception:
				data = None
	elif src and os.path.isfile(src):
		ext = os.path.splitext(src)[1].lower()
		if ext in _IMG_EXT:
			mime = _IMG_EXT[ext]
			with open(src, 'rb') as f:
				data = f.read()
	if data is None:
		response['statusCode'] = 404
		response['statusReason'] = 'Not Found'
		response['data'] = 'no thumb: ' + src
		return response
	response['statusCode'] = 200
	response['statusReason'] = 'OK'
	response['content-type'] = mime
	response['Cache-Control'] = 'max-age=2'
	response['data'] = data
	return response


def onHTTPRequest(webServerDAT, request, response):
	root = webServerDAT.parent().par.Webroot.eval()
	uri = request['uri']
	if uri in ('', '/'):
		uri = '/index.html'
	uri = uri.split('?')[0]      # drop the cache-bust query before resolving
	if uri == '/thumb':
		return _thumb(webServerDAT, request, response)

	root = os.path.normpath(root)
	path = os.path.normpath(os.path.join(root, uri.lstrip('/')))

	# no escaping the web root
	if not path.startswith(root) or not os.path.isfile(path):
		response['statusCode'] = 404
		response['statusReason'] = 'Not Found'
		response['data'] = '404: ' + uri
		return response

	mime = mimetypes.guess_type(path)[0] or 'application/octet-stream'
	with open(path, 'rb') as f:
		data = f.read()

	# stamp js/css refs in served HTML with their mtimes (CEF cache-bust)
	if mime == 'text/html':
		data = _stampAssets(data, root)

	response['statusCode'] = 200
	response['statusReason'] = 'OK'
	response['content-type'] = mime
	# webrenderTOP's CEF heuristically caches assets without this, serving
	# stale js/css after disk edits even across page reloads
	response['Cache-Control'] = 'no-cache'
	response['data'] = data
	return response


def onWebSocketOpen(webServerDAT, client, uri):
	_ext(webServerDAT).OnWSOpen(client)


def onWebSocketClose(webServerDAT, client):
	_ext(webServerDAT).OnWSClose(client)


def onWebSocketReceiveText(webServerDAT, client, data):
	_ext(webServerDAT).OnWSText(client, data)


def onWebSocketReceiveBinary(webServerDAT, client, data):
	return


def onWebSocketReceivePing(webServerDAT, client, data):
	webServerDAT.webSocketSendPong(client, data=data)


def onServerStart(webServerDAT):
	return


def onServerStop(webServerDAT):
	return
