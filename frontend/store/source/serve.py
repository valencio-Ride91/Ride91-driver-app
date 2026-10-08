# Tiny local server for drawing the Ride91 logo: serves this folder, and saves
# PNGs the page POSTs to /save?name=<file>.png into ./out. Local use only.
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.chdir(HERE)


class H(SimpleHTTPRequestHandler):
    def do_POST(self):
        u = urlparse(self.path)
        name = (parse_qs(u.query).get("name") or [""])[0]
        if u.path != "/save" or not re.fullmatch(r"[A-Za-z0-9_.-]+\.png", name):
            self.send_error(400)
            return
        data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if not data.startswith(b"\x89PNG"):
            self.send_error(400)
            return
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(data)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 5311), H).serve_forever()
