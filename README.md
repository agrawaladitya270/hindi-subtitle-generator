# Hindi Subs

Make Hindi subtitles (`.srt`) for any movie.

**Website: https://agrawaladitya270.github.io/hindi-subs/**

Open the site, choose a movie (or an existing `.srt`), and download `<movie>.hi.srt`.
Everything runs in your browser. The movie is never uploaded; only the subtitle text is sent to Google Translate.

## How it works

1. **Whisper** (speech-to-text) writes timed lines in the movie's own language.
2. Each line is translated to Hindi with **Google Translate** (free, needs internet).
3. The result is saved as `<movie>.hi.srt`. The original-language `<movie>.<lang>.srt` is offered too.

The website and the Python script do the same steps with the same settings:

| | Website | `hindi_subs.py` |
|---|---|---|
| Runs on | your browser (WebGPU, or CPU) | your PC (NVIDIA GPU, or CPU) |
| Speech-to-text | Whisper via [transformers.js](https://github.com/huggingface/transformers.js) | Whisper via [faster-whisper](https://github.com/SYSTRAN/faster-whisper) |
| Reads audio with | [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) | PyAV |
| Models | small, medium, large-v3-turbo, large-v3 | same |
| Options | audio language, audio track, don't use GPU | `--lang`, `--track`, `--cpu` |
| Translate an existing `.srt` | drop it on the page | `python hindi_subs.py movie.en.srt` |

### Speed (2-hour movie)

- Gaming graphics card, `large-v3-turbo`: about 10 min (measured ~12× real time on an RTX 4060 laptop GPU)
- Built-in laptop graphics, `small`: under an hour (~3× real time on Intel UHD)
- CPU only: hours. Use `small`, or the Python script.

Use Chrome or Edge. On a laptop with two graphics chips, set the browser to *High performance* in
Windows Settings › System › Display › Graphics. The model downloads once (0.3–2 GB) and is cached.

## Command line

```
pip install faster-whisper deep-translator

python hindi_subs.py movie.mp4                 # audio -> Hindi subtitles
python hindi_subs.py movie.mp4 --lang ja       # set audio language if auto-detect is wrong
python hindi_subs.py movie.mp4 --model small   # much faster on CPU, less accurate
python hindi_subs.py movie.mkv --track 1       # use the 2nd audio track (dual-audio files)
python hindi_subs.py movie.en.srt              # translate an existing .srt (no speech-to-text)
```

## Files

- `index.html`, `style.css`: the page
- `app.js`: main flow (read audio → speech-to-text → translate → save), like `main()` in the script
- `whisper-worker.js`: speech-to-text in a background thread
- `hindi_subs.js`: SRT helpers and Hindi translation, ported from the script
- `hindi_subs.py`: the original command-line script
- `vendor/ffmpeg/`: ffmpeg.wasm (MIT), served from this site so its worker can start
- `coi-serviceworker.js`: [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT); lets speech-to-text use all CPU cores on GitHub Pages

No build step. To run locally, serve the folder with any static server (for example `python -m http.server`) and open `http://localhost:8000`.
