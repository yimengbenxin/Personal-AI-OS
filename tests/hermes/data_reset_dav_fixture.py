"""Loopback-only fake drive implementing the scoped WebDAV operations used by the release tool."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import threading
from urllib.parse import quote, unquote, urlsplit
from xml.sax.saxutils import escape


@contextmanager
def drive(directory, moves=True, events=None, metadata=True):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def target(self):
            if events is not None:
                events.append(self.command)
            assert self.headers.get('Authorization') == 'Basic cGNpOnN5bnRoZXRpYw=='
            name = unquote(urlsplit(self.path).path)
            assert name.startswith('/dav/')
            path = (directory / name[5:]).resolve()
            assert path.is_relative_to(directory)
            return path

        def reply(self, status, body=b''):
            self.send_response(status)
            self.send_header('Content-Length', str(len(body))); self.end_headers()
            self.wfile.write(body)

        def do_PROPFIND(self):
            path = self.target()
            if not path.exists():
                self.reply(404); return
            values = [path, *sorted(path.iterdir())] if path.is_dir() else [path]
            def resource(p):
                name = p.relative_to(directory).as_posix()
                href = '/dav/' + (quote(name) if name != '.' else '') + ('/' if p.is_dir() and name != '.' else '')
                kind = '<d:collection/>' if p.is_dir() else ''
                info = p.stat()
                tag = str(info.st_ino)+'-'+str(info.st_mtime_ns)+'-'+str(info.st_ctime_ns)
                metadata_xml = '<d:getetag>'+tag+'</d:getetag>' if metadata else ''
                return ('<d:response><d:href>'+escape(href)+'</d:href><d:propstat><d:prop><d:resourcetype>'+kind+
                    '</d:resourcetype><d:getcontentlength>'+str(0 if p.is_dir() else p.stat().st_size)+
                    '</d:getcontentlength>'+metadata_xml+'</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>')
            self.reply(207, ('<d:multistatus xmlns:d="DAV:">'+''.join(map(resource,values))+'</d:multistatus>').encode())

        def do_GET(self):
            self.target(); self.reply(405)

        def do_DELETE(self):
            path = self.target()
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
            self.reply(204)

        def do_MKCOL(self):
            path = self.target()
            if path.exists():
                self.reply(405)
            else:
                path.mkdir(); self.reply(201)

        def do_MOVE(self):
            source = self.target()
            if not moves:
                self.reply(405); return
            name = unquote(urlsplit(self.headers['Destination']).path)
            assert name.startswith('/dav/') and self.headers['Overwrite'] == 'F'
            target = (directory/name[5:]).resolve()
            assert target.is_relative_to(directory)
            if target.exists():
                self.reply(412); return
            source.rename(target); self.reply(201)

        def do_PUT(self):
            path = self.target()
            path.write_bytes(self.rfile.read(int(self.headers['Content-Length'])))
            self.reply(201)

    server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread = threading.Thread(target=server.serve_forever,daemon=True); thread.start()
    try:
        yield 'http://127.0.0.1:' + str(server.server_port) + '/dav'
    finally:
        server.shutdown(); server.server_close(); thread.join()
