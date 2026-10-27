# Hindi Subtitle Generator

Generate Hindi subtitles (`.srt`) for any movie, in the browser or from the command line.

**Live site:** https://agrawaladitya270.github.io/hindi-subtitle-generator/

## Features

- **Free and open source.** Speech recognition (OpenAI Whisper) runs locally in the browser; the movie is never uploaded. Only subtitle text is sent to Google Translate.
- **Translate via English (default).** Whisper writes English directly from the speech, which is then translated to Hindi. For languages Whisper spells poorly (Telugu, Tamil, Kannada, …) this gives far clearer Hindi than translating its native-script transcript.
- **Sentence-level translation.** Subtitle fragments are joined into sentences before translation, then spread back over their original timing.
- **Whisper models:** Small, Medium, Large v3 Turbo, Large v3, GPU-accelerated through WebGPU with automatic CPU fallback. (Turbo transcribes only; it cannot translate to English.)
- **Any movie file.** MP4, MKV, AVI, MP3 and more via ffmpeg.wasm, including multi-track audio and AC-3.
- **Existing subtitles.** Drop an `.srt` to translate it directly.
- **Player-ready output.** Two lines per cue, 42 characters per line, UTF-8 with BOM. The intermediate `.srt` (English or the spoken language) is saved too, so translation can be redone without speech recognition.

## How it works

1. Whisper turns the selected audio track into timed English lines (or, with *Translate via English* off, lines in the spoken language).
2. Lines are joined into sentences and translated to Hindi with Google Translate.
3. The result is saved as `<movie>.hi.srt`, alongside `<movie>.en.srt` (or `<movie>.<lang>.srt`).

## Performance

| Hardware | Model | 2-hour movie |
|---|---|---|
| Dedicated GPU (RTX 4060 Laptop) | Large v3, via English | ~35 min (~3.7× real time) |
| Dedicated GPU (RTX 4060 Laptop) | Large v3 Turbo, direct | ~10 min (~12× real time) |
| Integrated GPU (Intel UHD) | Small | ~40 min (~3× real time) |
| CPU only | Small | several hours |

Chrome or Edge is recommended. Models are downloaded once (0.3–2 GB) and cached by the browser.

## Command-line tool

`cli/hindi_subtitles.py` runs the same pipeline natively with [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CUDA or CPU).

```
pip install faster-whisper deep-translator

python cli/hindi_subtitles.py movie.mp4                 # audio -> Hindi subtitles
python cli/hindi_subtitles.py movie.mp4 --lang ja       # set audio language if auto-detect is wrong
python cli/hindi_subtitles.py movie.mp4 --model small   # much faster on CPU, less accurate
python cli/hindi_subtitles.py movie.mkv --track 1       # use the 2nd audio track (dual-audio files)
python cli/hindi_subtitles.py movie.en.srt              # translate an existing .srt (no speech-to-text)
```

GPU use requires the CUDA 12 cuBLAS and cuDNN 9 libraries.

## Project structure

```
index.html                     Web app
assets/
  css/styles.css               Styles (light and dark)
  js/main.js                   App flow: read audio → transcribe → translate → save
  js/transcriber.worker.js     Whisper speech recognition in a Web Worker
  js/srt.js                    SRT parsing, writing and line splitting
  js/translate.js              Batched Google Translate client
  fonts/                       Inter (SIL Open Font License)
  vendor/ffmpeg/               ffmpeg.wasm (MIT)
coi-serviceworker.js           Enables multi-threaded WASM on GitHub Pages (MIT)
cli/hindi_subtitles.py         Command-line tool
```

## Local development

No build step. Serve the folder with any static server and open it on `localhost`:

```
python -m http.server 8000
```

## Acknowledgements

[Whisper](https://github.com/openai/whisper) ·
[transformers.js](https://github.com/huggingface/transformers.js) ·
[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) ·
[coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) ·
[Inter](https://github.com/rsms/inter)
