import os
import sys

from faster_whisper import WhisperModel

sys.stdout.reconfigure(encoding="utf-8")


def main():
    if len(sys.argv) != 2:
        print("usage: transcribe.py <wav>", file=sys.stderr)
        sys.exit(2)

    model_name = os.environ.get("AGENTBRIDGE_STT_MODEL", "small")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(sys.argv[1], language="zh")
    print("".join(segment.text for segment in segments).strip())


if __name__ == "__main__":
    main()
