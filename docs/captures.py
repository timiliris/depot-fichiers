#!/usr/bin/env python3
"""Régénère les captures d'écran du README.

Sert les vrais fichiers de `gateway/web/` — donc l'interface réellement livrée —
avec une API bouchonnée qui renvoie des données de démonstration. C'est ce qui
permet des captures reproductibles, sans dépendre d'une installation en service
ni y exposer de vrais noms de fichiers.

    python3 docs/captures.py

Nécessite Chrome ou Chromium pour la capture ; sans lui, le serveur reste
ouvert sur http://127.0.0.1:8777 pour une capture manuelle.
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

ICI = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ICI, "..", "gateway", "web")
PORT = 8777

JOUR = 86_400_000
MAINTENANT = 1_784_000_000_000  # figé (juillet 2026): garde les captures stables

DEMO = [
    {"path_type": "Dir", "name": "Vacances 2026", "mtime": MAINTENANT - 2 * JOUR, "size": 4},
    {"path_type": "Dir", "name": "Rushes caméra", "mtime": MAINTENANT - 9 * JOUR, "size": 4},
    {"path_type": "File", "name": "randonnee-cirque-de-gavarnie.mp4", "mtime": MAINTENANT - 3600_000, "size": 4_812_331_008},
    {"path_type": "File", "name": "concert-plein-air-4k.mkv", "mtime": MAINTENANT - 5 * 3600_000, "size": 12_402_653_184},
    {"path_type": "File", "name": "montage-final-v3.mov", "mtime": MAINTENANT - 2 * JOUR, "size": 2_147_483_648},
    {"path_type": "File", "name": "photos-famille.zip", "mtime": MAINTENANT - 6 * JOUR, "size": 894_784_512},
    {"path_type": "File", "name": "notes-tournage.txt", "mtime": MAINTENANT - 11 * JOUR, "size": 4_096},
]

SESSION = {"authenticated": True, "user": "camille", "admin": False, "title": "Dépôt"}
QUOTA = {"available": True, "total": 107_374_182_400, "used": 21_638_924_288, "free": 85_735_258_112}


class Bouchon(http.server.SimpleHTTPRequestHandler):
    """Sert gateway/web/ tel quel, et bouchonne les quelques appels d'API."""

    deconnecte = False  # basculé pour capturer l'écran de connexion

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.abspath(WEB), **kw)

    def _json(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/session"):
            return self._json({"authenticated": False, "title": "Dépôt"}
                              if Bouchon.deconnecte else SESSION)
        if self.path.startswith("/api/quota"):
            return self._json(QUOTA)
        if self.path.startswith("/api/fs/"):
            return self._json({
                "href": "/", "kind": "Index", "uri_prefix": "/",
                "allow_upload": True, "allow_delete": True, "allow_search": True,
                "allow_archive": True, "dir_exists": True, "auth": True,
                "user": SESSION["user"], "paths": DEMO,
            })
        return super().do_GET()

    def log_message(self, *a):
        pass


def capture(chrome, url, sortie, largeur, hauteur):
    subprocess.run(
        [chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         f"--window-size={largeur},{hauteur}",
         "--virtual-time-budget=4000", f"--screenshot={sortie}", url],
        check=True, capture_output=True,
    )
    print(f"  {os.path.basename(sortie)}  {largeur}×{hauteur}")


def trouver_chrome():
    for c in ("google-chrome", "chromium", "chromium-browser", "chrome"):
        if shutil.which(c):
            return shutil.which(c)
    mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    return mac if os.path.exists(mac) else None


def main():
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", PORT), Bouchon)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    time.sleep(0.3)
    url = f"http://127.0.0.1:{PORT}/"

    chrome = trouver_chrome()
    if not chrome:
        print(f"Chrome introuvable. Serveur ouvert sur {url} — Ctrl+C pour arrêter.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            return

    print("captures :")
    Bouchon.deconnecte = False
    capture(chrome, url, os.path.join(ICI, "liste.png"), 1440, 620)
    capture(chrome, url, os.path.join(ICI, "mobile.png"), 414, 720)
    Bouchon.deconnecte = True
    capture(chrome, url, os.path.join(ICI, "connexion.png"), 1440, 620)
    srv.shutdown()


if __name__ == "__main__":
    sys.exit(main())
