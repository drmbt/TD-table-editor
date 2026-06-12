"""
webserverDAT callbacks for TableEditor.

HTTP: serves static files from the folder in the comp's Webroot par.
WebSocket: relays open/close/text to the TableEditorExt extension.
"""

import os
import mimetypes


def _ext(webServerDAT):
	return webServerDAT.parent().ext.TableEditorExt


def onHTTPRequest(webServerDAT, request, response):
	root = webServerDAT.parent().par.Webroot.eval()
	uri = request['uri']
	if uri in ('', '/'):
		uri = '/index.html'

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
