#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Music Showcase · 節目單蒐集 — Apps Script 的本機模擬後端
Local mock of the Apps Script backend, same JSON contract.

跑法 / Run:
    python3 mock_server.py            # http://localhost:8899
    python3 mock_server.py 9000       # 換 port

網址 / URLs:
    /             → index.html（本機模式）
    /cloud.html   → index.html 自動把 CONFIG.API_URL 指到 /api（雲端模式）
    /api?action=list   (GET)
    /api               (POST，同 Apps Script 的 doPost)
"""

import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(ROOT, "repertoire_db.json")

LOCK = threading.Lock()

HEADERS = ['id', 'name', 'piece', 'composer', 'instrument', 'instrument_other',
           'dur_min', 'dur_sec', 'has_accomp', 'accomp_count', 'accomp_inst',
           'accomp_other', 'accomp_teacher', 'contact', 'note', 'at']


# --------------------------------------------------------------------- store

def load_db():
    if os.path.exists(DB_PATH):
        with open(DB_PATH, encoding="utf-8") as f:
            return json.load(f)
    return []  # 開放式表單，初始為空


def save_db(data):
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


DB = load_db()


def find(db, eid):
    for e in db:
        if str(e.get("id")) == str(eid):
            return e
    return None


def public_view(lst):
    """對外檢視：拿掉 contact / note（與 Apps Script 的 publicView_ 一致）"""
    out = []
    for e in lst or []:
        out.append({k: e.get(k, "") for k in HEADERS if k not in ("contact", "note")})
    return out


def PUB():
    return public_view(DB)


# ------------------------------------------------------------------- actions

def act_add(body):
    e = body.get("entry") or {}
    name = str(e.get("name", "")).strip()
    piece = str(e.get("piece", "")).strip()
    if not name:
        return {"ok": False, "error": "missing name"}
    if not piece:
        return {"ok": False, "error": "missing piece"}
    if not e.get("id"):
        e["id"] = "r" + format(int(time.time() * 1000), "x")
    e["at"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    DB.append(e)
    save_db(DB)
    return {"ok": True, "entry": public_view([e])[0], "entries": PUB()}


def act_update(body):
    eid = body.get("id")
    old = find(DB, eid)
    if old is None:
        return {"ok": False, "error": "entry not found"}

    e = body.get("entry") or {}
    name = str(e.get("name", "")).strip()
    piece = str(e.get("piece", "")).strip()
    if not name:
        return {"ok": False, "error": "missing name"}
    if not piece:
        return {"ok": False, "error": "missing piece"}

    e["id"] = old["id"]
    e["at"] = old.get("at") or time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    e["contact"] = str(e.get("contact", "")) or old.get("contact", "")
    e["note"] = str(e.get("note", "")) or old.get("note", "")

    for i, x in enumerate(DB):
        if str(x.get("id")) == str(eid):
            DB[i] = e
            break
    save_db(DB)
    return {"ok": True, "entry": public_view([e])[0], "entries": PUB()}


def act_delete(body):
    eid = body.get("id")
    idx = None
    for i, x in enumerate(DB):
        if str(x.get("id")) == str(eid):
            idx = i
            break
    if idx is None:
        return {"ok": False, "error": "entry not found"}
    DB.pop(idx)
    save_db(DB)
    return {"ok": True, "entries": PUB()}


ACTIONS = {
    "add": act_add,
    "update": act_update,
    "delete": act_delete,
}


# -------------------------------------------------------------------- server

class Handler(BaseHTTPRequestHandler):
    server_version = "MusicShowcaseRepertoireMock/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[mock] %s\n" % (fmt % args))

    def _send(self, code, body, ctype):
        raw = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    def do_GET(self):
        path = urlparse(self.path).path
        qs = parse_qs(urlparse(self.path).query)

        if path in ("/api", "/api/"):
            action = (qs.get("action") or ["list"])[0]
            with LOCK:
                if action in ("list", "ping"):
                    return self._json({"ok": True, "entries": PUB()})
            return self._json({"ok": False, "error": "unknown action: " + action})

        if path in ("/", "/index.html"):
            return self._send_file("index.html", "text/html; charset=utf-8", inject_api=False)
        if path == "/cloud.html":
            return self._send_file("index.html", "text/html; charset=utf-8", inject_api=True)

        return self._send(404, "not found", "text/plain; charset=utf-8")

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/api", "/api/"):
            return self._send(404, "not found", "text/plain; charset=utf-8")

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            body = json.loads(raw)
        except Exception as exc:
            return self._json({"ok": False, "error": "bad json: %s" % exc})

        action = body.get("action")
        fn = ACTIONS.get(action)
        if fn is None:
            return self._json({"ok": False, "error": "unknown action: %s" % action})

        with LOCK:
            return self._json(fn(body))

    def _send_file(self, name, ctype, inject_api=False):
        p = os.path.join(ROOT, name)
        if not os.path.exists(p):
            return self._send(404, "missing " + name, "text/plain; charset=utf-8")
        with open(p, encoding="utf-8") as f:
            html = f.read()
        if inject_api:
            html = re.sub(r"API_URL:\s*'[^']*'", "API_URL: '/api'", html)
            if "API_URL: '/api'" not in html:
                return self._send(500, "could not inject API_URL", "text/plain; charset=utf-8")
        return self._send(200, html, ctype)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("Music Showcase repertoire mock backend on http://localhost:%d" % port)
    print("  本機模式 : http://localhost:%d/" % port)
    print("  雲端模式 : http://localhost:%d/cloud.html" % port)
    print("  DB       : %s (%d entries)" % (DB_PATH, len(DB)))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
