#!/usr/bin/env python3
"""
Make Hindi subtitles (.srt) for a movie.

How it works
  1. Whisper (speech-to-text) writes timed lines in the movie's own language.
  2. Each line is translated to Hindi with Google Translate (free, needs internet).
  3. The result is saved as <movie>.hi.srt next to the movie.

Install (Python 3.9+, no ffmpeg needed):
  pip install faster-whisper deep-translator

Use:
  python hindi_subs.py movie.mp4                 # audio -> Hindi subtitles
  python hindi_subs.py movie.mp4 --lang ja       # set audio language if auto-detect is wrong
  python hindi_subs.py movie.mp4 --model small   # much faster on CPU, less accurate
  python hindi_subs.py movie.mkv --track 1       # use the 2nd audio track (dual-audio files)
  python hindi_subs.py movie.en.srt              # translate an existing .srt (no speech-to-text)
"""
import argparse
import os
import re
import sys
import textwrap
import time
from pathlib import Path


# ---------------- SRT helpers ----------------

def fmt_time(sec):
    ms = int(round(max(sec, 0) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(cues, path):
    # UTF-8 with BOM, so players on Windows / TVs read Hindi correctly
    with open(path, "w", encoding="utf-8-sig") as f:
        for n, (start, end, text) in enumerate(cues, 1):
            f.write(f"{n}\n{fmt_time(start)} --> {fmt_time(end)}\n{text}\n\n")


TIME_RE = re.compile(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)")


def read_srt(path):
    raw = Path(path).read_text(encoding="utf-8-sig", errors="replace").replace("\r\n", "\n")
    cues = []
    for block in re.split(r"\n\s*\n", raw.strip()):
        lines = block.split("\n")
        for i, line in enumerate(lines):
            t = TIME_RE.search(line)
            if not t:
                continue
            h1, m1, s1, ms1, h2, m2, s2, ms2 = map(int, t.groups())
            text = " ".join(x.strip() for x in lines[i + 1:] if x.strip())
            text = re.sub(r"<[^>]*>|\{[^}]*\}", "", text).strip()  # drop <i>, {\an8} tags
            if text:
                cues.append((h1 * 3600 + m1 * 60 + s1 + ms1 / 1000,
                             h2 * 3600 + m2 * 60 + s2 + ms2 / 1000, text))
            break
    return cues


def split_cue(start, end, text, width=42):
    """Max 2 lines on screen. Longer text is split into several cues over the same time."""
    lines = textwrap.wrap(text, width)
    if not lines:
        return []
    groups = ["\n".join(lines[k:k + 2]) for k in range(0, len(lines), 2)]
    total = sum(len(g) for g in groups)
    cues, t = [], start
    for g in groups:
        d = (end - start) * len(g) / total
        cues.append((t, t + d, g))
        t += d
    return cues


# ---------------- 1. speech -> text ----------------

def load_audio(path, track):
    """Read one audio track as 16 kHz mono. (faster-whisper's own reader breaks with PyAV 19+.)"""
    import av
    import numpy as np
    try:
        c = av.open(str(path))
    except av.error.FFmpegError as e:
        sys.exit(f"Cannot read this file as video/audio: {e}")
    with c:
        tracks = c.streams.audio
        if not tracks:
            sys.exit("No audio track in this file.")
        if len(tracks) > 1:
            names = ", ".join(f"{i}={s.metadata.get('language', '?')}" for i, s in enumerate(tracks))
            print(f"Audio tracks: {names}  -> using {track} (change with --track)")
        if track >= len(tracks):
            sys.exit(f"No audio track {track}.")
        rs = av.AudioResampler(format="s16", layout="mono", rate=16000)
        chunks = []
        for packet in c.demux(tracks[track]):
            try:
                frames = packet.decode()
            except av.error.FFmpegError:  # skip a broken bit of the file
                continue
            for frame in frames:
                chunks += [f.to_ndarray().reshape(-1) for f in rs.resample(frame)]
        chunks += [f.to_ndarray().reshape(-1) for f in rs.resample(None)]
    if not chunks:
        sys.exit("Could not read any audio.")
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def transcribe(path, model_name, lang, force_cpu, track):
    import ctranslate2
    from faster_whisper import WhisperModel

    print("Reading audio...")
    audio = load_audio(path, track)

    def run(device):
        print(f"Loading Whisper '{model_name}' on {device.upper()} (first run downloads the model)...")
        model = WhisperModel(model_name, device=device, compute_type="auto",
                             cpu_threads=os.cpu_count() or 4)
        segments, info = model.transcribe(
            audio,
            language=lang,                     # None = auto-detect
            beam_size=5,
            vad_filter=True,                   # skip silence/music -> fewer made-up lines
            condition_on_previous_text=False,  # stops one line repeating again and again
        )
        print(f"Audio language: {info.language} ({info.language_probability:.0%} sure), "
              f"length {info.duration / 60:.0f} min")
        cues = []
        for seg in segments:
            if seg.text.strip():
                cues.append((seg.start, seg.end, seg.text.strip()))
            print(f"\r  speech-to-text: {seg.end / max(info.duration, 1):.0%}", end="", flush=True)
        print()
        return cues, info.language

    if not force_cpu and ctranslate2.get_cuda_device_count() > 0:
        try:
            return run("cuda")
        except Exception as e:  # usually missing CUDA 12 / cuDNN 9 libraries
            print(f"\nGPU failed: {e}\nRetrying on CPU (slower). Use --cpu to skip the GPU next time.")
    return run("cpu")


# ---------------- 2. text -> Hindi ----------------

def translate_to_hindi(lines):
    from deep_translator import GoogleTranslator
    gt = GoogleTranslator(source="auto", target="hi")

    def call(text):
        for wait in (2, 5, 15, None):  # retry with pauses
            try:
                return gt.translate(text) or ""
            except Exception as e:
                if wait is None:
                    raise RuntimeError(f"Google Translate failed: {e!r}") from e
                time.sleep(wait)

    out, i = [], 0
    while i < len(lines):
        # Send ~1000 characters per request, one subtitle per line.
        chunk, size = [], 0
        while i < len(lines) and (not chunk or size + len(lines[i]) < 1000):
            chunk.append(lines[i])
            size += len(lines[i]) + 1
            i += 1
        try:
            parts = call("\n".join(chunk)).split("\n")
        except RuntimeError:
            parts = []
        if len(parts) != len(chunk):  # line count changed -> do this chunk line by line
            parts = [call(line) for line in chunk]
        out += [p.strip() or orig for p, orig in zip(parts, chunk)]  # keep original if empty
        print(f"\r  translating: {i / len(lines):.0%}", end="", flush=True)
        time.sleep(0.5)  # be gentle with the free endpoint
    print()
    return out


# ---------------- main ----------------

def main():
    ap = argparse.ArgumentParser(description="Make Hindi subtitles (.srt) for a movie.")
    ap.add_argument("input", help="movie/audio file, or an existing .srt to translate")
    ap.add_argument("--model", default="large-v3-turbo",
                    help="Whisper model: small (fast), medium, large-v3-turbo (default), "
                         "large-v3 (best, slowest)")
    ap.add_argument("--lang", help="audio language code, e.g. en, ja, ko (default: auto-detect)")
    ap.add_argument("--track", type=int, default=0,
                    help="audio track number, for files with several languages (default 0)")
    ap.add_argument("--cpu", action="store_true", help="do not use the GPU")
    ap.add_argument("-o", "--out", help="output file (default: <movie>.hi.srt)")
    args = ap.parse_args()

    src = Path(args.input)
    if not src.is_file():
        sys.exit(f"File not found: {src}")
    base = src.with_suffix("")  # movie.mp4 -> movie

    if src.suffix.lower() == ".srt":
        cues, lang = read_srt(src), None
        if re.fullmatch(r"\.[a-z]{2}", base.suffix):  # movie.en.srt -> movie
            base = base.with_suffix("")
    else:
        cues, lang = transcribe(src, args.model, args.lang, args.cpu, args.track)
    if not cues:
        sys.exit("No speech / subtitles found.")
    if lang:  # save original-language subtitles first, so this slow step is never lost
        orig = Path(f"{base}.{lang}.srt")
        write_srt(cues, orig)
        print(f"Saved original-language subtitles: {orig}")

    texts = [t.replace("\n", " ") for _, _, t in cues]
    try:
        hindi = texts if lang == "hi" else translate_to_hindi(texts)
    except RuntimeError as e:
        sys.exit(f"\n{e}\nTry again later with the saved .srt as input (skips speech-to-text).")

    final = []
    for (start, end, _), text in zip(cues, hindi):
        final += split_cue(start, end, text)

    out = Path(args.out) if args.out else Path(f"{base}.hi.srt")
    write_srt(final, out)
    print(f"Done: {out}  ({len(final)} subtitles)")


if __name__ == "__main__":
    main()
