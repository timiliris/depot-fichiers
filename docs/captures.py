#!/usr/bin/env python3
"""Regenerates the README screenshots.

Serves the real files from `gateway/web/` — the interface actually shipped — with
a stubbed API returning demo data. That keeps the screenshots reproducible,
without depending on a running install or exposing any real filename.

    python3 docs/captures.py

Each scene drives the shipped code through its own API: the "uploads" scene, for
instance, builds real Upload components and paints them, rather than mocking up
what the queue looks like.

Needs Chrome or Chromium. Without one, the server stays up on
http://127.0.0.1:8777 so the shots can be taken by hand.
"""

import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "..", "gateway", "web")
PORT = 8777

DAY = 86_400_000
NOW = 1_784_000_000_000  # pinned (July 2026) so the shots stay stable

DEMO = [
    {"path_type": "Dir", "name": "Holiday 2026", "mtime": NOW - 2 * DAY, "size": 4},
    {"path_type": "Dir", "name": "Camera rushes", "mtime": NOW - 9 * DAY, "size": 4},
    {"path_type": "File", "name": "hike-cirque-de-gavarnie.mp4", "mtime": NOW - 3600_000, "size": 4_812_331_008},
    {"path_type": "File", "name": "open-air-concert-4k.mkv", "mtime": NOW - 5 * 3600_000, "size": 12_402_653_184},
    {"path_type": "File", "name": "final-cut-v3.mov", "mtime": NOW - 2 * DAY, "size": 2_147_483_648},
    {"path_type": "File", "name": "family-photos.zip", "mtime": NOW - 6 * DAY, "size": 894_784_512},
    {"path_type": "File", "name": "shoot-notes.txt", "mtime": NOW - 11 * DAY, "size": 4_096},
]

QUOTA = {"available": True, "total": 107_374_182_400, "used": 21_638_924_288, "free": 85_735_258_112}

# Each scene appends a snippet to the real app.js. The snippet only calls the
# interface's own entry points, so what gets photographed is the shipped code.
SCENES = {
    "list": "",
    "login": "",
    "mobile": "",
    "grid": "setView(true);",
    "uploads": """
    const stage = (name, size, sent, status, label) => {
      const u = new Upload({ name, size, slice: () => new Blob() }, name, "/");
      document.getElementById("uploads").hidden = false;
      document.getElementById("uploadsBody").append(u.el);
      queue.items.push(u);
      u.status = status;
      u.sent = sent;
      u.speed = 11.4 * 1024 * 1024;
      if (status === "done") { u.el.classList.add("is-done"); u.$pause.remove(); u.$cancel.remove(); }
      u.paint(label);
      if (status === "done") u.$state.classList.add("is-ok");
    };
    stage("open-air-concert-4k.mkv", 12_402_653_184, 5_368_709_120, "running");
    stage("hike-cirque-de-gavarnie.mp4", 4_812_331_008, 1_073_741_824, "paused", t("up_paused"));
    stage("shoot-notes.txt", 4_096, 4_096, "done", t("up_done"));
    """,
}


class Stub(http.server.SimpleHTTPRequestHandler):
    """Serves gateway/web/ untouched, and stubs the handful of API calls."""

    scene = "list"
    lang = "en"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.abspath(WEB), **kw)

    def _json(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _text(self, body, ctype):
        raw = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.startswith("/api/session"):
            signed_in = Stub.scene != "login"
            return self._json({
                "authenticated": signed_in, "user": "camille", "admin": False,
                "title": "Drop", "lang": Stub.lang,
            })
        if self.path.startswith("/api/quota"):
            return self._json(QUOTA)
        if self.path.startswith("/api/fs/"):
            return self._json({
                "href": "/", "kind": "Index", "uri_prefix": "/",
                "allow_upload": True, "allow_delete": True, "allow_search": True,
                "allow_archive": True, "dir_exists": True, "auth": True,
                "user": "camille", "paths": DEMO,
            })
        if self.path.startswith("/app.js"):
            src = open(os.path.join(WEB, "app.js"), encoding="utf-8").read()
            extra = SCENES.get(Stub.scene, "")
            if extra:
                # Wait for boot() to finish before touching the interface.
                src += (
                    "\n/* capture harness */\n"
                    "(function () {\n"
                    "  const ready = setInterval(() => {\n"
                    "    if (!document.body.classList.contains('authed')) return;\n"
                    "    clearInterval(ready);\n"
                    f"    {extra}\n"
                    "  }, 30);\n"
                    "})();\n"
                )
            return self._text(src, "text/javascript; charset=utf-8")
        return super().do_GET()

    def log_message(self, *a):
        pass


def shoot(chrome, url, out, width, height):
    subprocess.run(
        [chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         f"--window-size={width},{height}",
         "--virtual-time-budget=5000", f"--screenshot={out}", url],
        check=True, capture_output=True,
    )
    print(f"  {os.path.basename(out):16} {width}×{height}")


def find_chrome():
    for c in ("google-chrome", "chromium", "chromium-browser", "chrome"):
        if shutil.which(c):
            return shutil.which(c)
    mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    return mac if os.path.exists(mac) else None


SHOTS = [
    # scene,     lang, file,            width, height
    ("list",     "en", "list.png",       1440, 620),
    ("grid",     "en", "grid.png",       1440, 620),
    ("uploads",  "en", "uploads.png",    1440, 700),
    ("login",    "en", "login.png",      1440, 620),
    ("mobile",   "en", "mobile.png",      414, 720),
    ("list",     "fr", "list-fr.png",    1440, 620),
]


def main():
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", PORT), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    time.sleep(0.3)
    url = f"http://127.0.0.1:{PORT}/"

    chrome = find_chrome()
    if not chrome:
        print(f"Chrome not found. Server left running on {url} — Ctrl+C to stop.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            return

    print("screenshots:")
    for scene, lang, name, w, h in SHOTS:
        Stub.scene, Stub.lang = scene, lang
        shoot(chrome, url, os.path.join(HERE, name), w, h)
    srv.shutdown()


if __name__ == "__main__":
    sys.exit(main())
