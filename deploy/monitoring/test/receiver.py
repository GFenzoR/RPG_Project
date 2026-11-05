"""Alert test receiver (T4.4, `make monitoring-test`): logs every Alertmanager webhook.

Only for local verification; never part of a real deployment.
"""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 (http.server API)
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            msg = json.loads(body)
            for a in msg.get("alerts", []):
                print(
                    "ALERT",
                    a.get("status"),
                    a.get("labels", {}).get("alertname"),
                    a.get("labels", {}).get("severity"),
                    a.get("annotations", {}).get("summary"),
                    flush=True,
                )
        except ValueError:
            print("non-JSON body:", body[:200], flush=True)
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass


HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
