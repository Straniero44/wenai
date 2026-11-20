"""Print one canonical phrase per line from the default microphone.

The companion decides what a phrase means. This process only spots the
words and writes them to stdout. A missing model or microphone exits
without touching motion.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

RATE = 16000
FRAME_BYTES = 1600  # 50 ms of 16 kHz s16le mono

# Homophones print as the canonical phrase on their left.
PHRASES = (
    ("太快了", ("太快啦", "太块了", "泰快了", "有点太快了")),
    ("太慢了", ("太慢啦", "太曼了", "有点太慢了")),
    ("快一点", ("快一些", "再快一点")),
    ("慢一点", ("慢一些", "再慢一点")),
    ("停下来", ("停下", "停止")),
)


def keyword_lines(model_dir: Path) -> list[str]:
    from sherpa_onnx import text2token

    texts = []
    labels = []
    for canonical, variants in PHRASES:
        texts.append(canonical)
        labels.append(canonical)
        for variant in variants:
            texts.append(variant)
            labels.append(canonical)
    encoded = text2token(
        [text.upper() for text in texts],
        tokens=str(model_dir / "tokens.txt"),
        tokens_type="cjkchar+bpe",
        bpe_model=str(model_dir / "bpe.model"),
    )
    lines = []
    for tokens, label in zip(encoded, labels, strict=True):
        lines.append(" ".join(tokens) + f" @{label}")
    return lines


def open_spotter(model_dir: Path, keywords_file: Path):
    import sherpa_onnx

    return sherpa_onnx.KeywordSpotter(
        provider="cpu",
        num_threads=1,
        max_active_paths=8,
        keywords_score=2.0,
        keywords_threshold=0.1,
        num_trailing_blanks=0,
        keywords_file=str(keywords_file),
        tokens=str(model_dir / "tokens.txt"),
        encoder=str(model_dir / "encoder.onnx"),
        decoder=str(model_dir / "decoder.onnx"),
        joiner=str(model_dir / "joiner.onnx"),
    )


def feed(spotter, stream, pcm: bytes) -> str | None:
    if len(pcm) < 2:
        return None
    import numpy as np

    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    stream.accept_waveform(RATE, samples)
    heard = None
    while spotter.is_ready(stream):
        spotter.decode_stream(stream)
        result = spotter.get_result(stream)
        if result:
            spotter.reset_stream(stream)
            heard = str(result).strip()
    return heard


def record_command() -> list[str] | None:
    if shutil.which("pw-record"):
        return [
            "pw-record",
            "--rate",
            str(RATE),
            "--channels",
            "1",
            "--channel-map",
            "mono",
            "--format",
            "s16",
            "--raw",
            "-",
        ]
    if shutil.which("parecord"):
        return [
            "parecord",
            "--raw",
            "--rate",
            str(RATE),
            "--channels",
            "1",
            "--format",
            "s16le",
            "-",
        ]
    return None


def iter_pcm(path: str | None):
    if path:
        data = Path(path).read_bytes()
        for offset in range(0, len(data), FRAME_BYTES):
            yield data[offset : offset + FRAME_BYTES]
        return
    command = record_command()
    if command is None:
        print("no pw-record or parecord on PATH", file=sys.stderr)
        raise SystemExit(2)
    process = subprocess.Popen(command, stdout=subprocess.PIPE)
    assert process.stdout is not None
    try:
        while True:
            frame = process.stdout.read(FRAME_BYTES)
            if not frame:
                return
            yield frame
    finally:
        process.terminate()


def run(model_dir: Path, pcm_file: str | None) -> int:
    required = ("tokens.txt", "bpe.model", "encoder.onnx", "decoder.onnx", "joiner.onnx")
    missing = [name for name in required if not (model_dir / name).is_file()]
    if missing:
        print(f"voice model is missing {', '.join(missing)}", file=sys.stderr)
        return 2
    try:
        lines = keyword_lines(model_dir)
    except ImportError:
        print("sherpa_onnx is not installed", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory() as directory:
        keywords = Path(directory) / "keywords.txt"
        keywords.write_text("\n".join(lines) + "\n", encoding="utf-8")
        spotter = open_spotter(model_dir, keywords)
        stream = spotter.create_stream()
        for frame in iter_pcm(pcm_file):
            heard = feed(spotter, stream, frame)
            if heard:
                print(heard, flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", default="")
    parser.add_argument("--pcm-file", default="")
    args = parser.parse_args()
    model_dir = Path(args.model_dir).expanduser() if args.model_dir else None
    if model_dir is None or not model_dir.is_dir():
        print("voice model directory is empty", file=sys.stderr)
        return 2
    try:
        return run(model_dir, args.pcm_file or None)
    except BrokenPipeError:
        return 0
    except Exception as error:  # noqa: BLE001 — the companion must keep serving
        print(f"voice listener stopped: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
