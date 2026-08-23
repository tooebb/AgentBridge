import os
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.stdout.reconfigure(encoding="utf-8")

from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("AGENTBRIDGE_STT_MODEL", "small")
PORT = int(os.environ.get("AGENTBRIDGE_STT_PORT", "8790"))

model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")


def transcribe_bytes(wav: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(wav)
        path = f.name
    try:
        segments, _info = model.transcribe(path, language="zh")
        return "".join(segment.text for segment in segments).strip()
    finally:
        os.unlink(path)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ready"}')
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path != "/transcribe":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", "0"))
        wav = self.rfile.read(length)
        try:
            body = transcribe_bytes(wav).encode("utf-8")
            self.send_response(200)
        except Exception as e:
            body = f"ERROR: {e}".encode("utf-8")
            self.send_response(500)

        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("READY", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
