"""
webserverDAT callbacks for TableEditor.

HTTP: serves static files from the folder in the comp's Webroot par.
WebSocket: relays open/close/text to the TableEditorExt extension.
"""

import os
import mimetypes


def _ext(webServerDAT):
	return webServerDAT.parent().ext.TableEditorExt


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
	if uri.split('?')[0] == '/thumb':
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
