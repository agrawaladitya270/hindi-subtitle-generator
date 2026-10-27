// Speech-to-text in a background thread (step 1 of cli/hindi_subtitles.py), using Whisper via transformers.js.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";

env.allowLocalModels = false;

const SR = 16000;          // Whisper wants 16 kHz mono
const FRAME = 480;         // 30 ms loudness frames for the silence finder
const FRAME_S = FRAME / SR;
const MAX_WIN = 29.5;      // Whisper hears at most 30 s at a time
const MIN_WIN = 15;        // when cutting long speech, cut at the quietest point after this

let asr = null;
let sot = null;            // <|startoftranscript|>
let langOfToken = null;    // token id -> "ja"
let detected = null;       // language found on the first speech
let carry = null;          // audio held back from the previous piece: { audio, start }

const post = (msg) => self.postMessage(msg);

self.onmessage = async ({ data: msg }) => {
  try {
    const result = msg.type === "load" ? await load(msg) : await transcribePiece(msg);
    post({ id: msg.id, result });
  } catch (e) {
    post({ id: msg.id, error: String(e?.message ?? e) });
  }
};

async function load({ model, device, dtype }) {
  const files = {};
  asr = await pipeline("automatic-speech-recognition", model, {
    device,
    dtype,
    progress_callback: (p) => {
      if (p.status !== "progress" || !p.total) return;
      files[p.file] = [p.loaded, p.total];
      const all = Object.values(files);
      post({ type: "download", loaded: all.reduce((n, f) => n + f[0], 0), total: all.reduce((n, f) => n + f[1], 0) });
    },
  });
  const gc = asr.model.generation_config;
  sot = gc.decoder_start_token_id;
  langOfToken = new Map(Object.entries(gc.lang_to_id).map(([tok, id]) => [id, tok.slice(2, -2)]));
  detected = null;
  carry = null;
  return true;
}

// Loudness of every 30 ms frame, in dB.
function loudness(audio) {
  const n = Math.floor(audio.length / FRAME);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * FRAME; j < (i + 1) * FRAME; j++) s += audio[j] * audio[j];
    db[i] = 10 * Math.log10(s / FRAME + 1e-10);
  }
  return db;
}

// Split audio into windows of at most 30 s that contain sound, skipping long silences
// (like vad_filter in the Python script: fewer made-up lines). Returns [[start, end]] in seconds.
function soundWindows(audio) {
  const db = loudness(audio);
  const n = db.length;
  if (!n) return [];
  const sorted = Float32Array.from(db).sort();
  const floor = sorted[Math.floor(n * 0.1)];
  const thr = Math.min(Math.max(floor + 6, -60), -45);  // only drop really quiet parts

  const gap = Math.round(0.6 / FRAME_S), pad = Math.round(0.3 / FRAME_S), minLen = Math.round(0.2 / FRAME_S);
  const regions = [];
  let start = -1, last = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && db[i] > thr) {
      if (start < 0) start = i;
      last = i;
    } else if (start >= 0 && (i === n || i - last > gap)) {
      if (last + 1 - start >= minLen) regions.push([Math.max(0, start - pad), Math.min(n, last + 1 + pad)]);
      start = -1;
    }
  }

  const maxW = Math.floor(MAX_WIN / FRAME_S), minW = Math.floor(MIN_WIN / FRAME_S);
  const quietest = (a, b) => {
    let best = a;
    for (let i = a; i < b; i++) if (db[i] < db[best]) best = i;
    return best;
  };
  const wins = [];
  let ws = null, we = null;
  for (const [s, e] of regions) {
    if (ws !== null && e - ws <= maxW) { we = Math.max(we, e); continue; }
    if (ws !== null) wins.push([ws, we]);
    ws = Math.max(s, we ?? 0);
    we = e;
    while (we - ws > maxW) {  // long speech: cut at the quietest moment
      const cut = quietest(ws + minW, ws + maxW);
      wins.push([ws, cut]);
      ws = cut;
    }
  }
  if (ws !== null && we > ws) wins.push([ws, we]);
  return wins.map(([a, b]) => [a * FRAME_S, b * FRAME_S]);
}

const slice = (audio, a, b) => audio.subarray(Math.floor(a * SR), Math.min(audio.length, Math.ceil(b * SR)));

// Whisper's first token after <|startoftranscript|> is the language. Vote over a few windows.
async function detectLanguage(audio, wins) {
  const picks = [...wins].sort((x, y) => (y[1] - y[0]) - (x[1] - x[0])).slice(0, 3);
  const votes = {};
  for (const [a, b] of picks) {
    const { input_features } = await asr.processor(slice(audio, a, b));
    const out = await asr.model.generate({ inputs: input_features, decoder_input_ids: [sot], max_new_tokens: 1 });
    let code = langOfToken.get(Number(out.tolist()[0].at(-1)));
    if (code === "yue") code = "zh";  // large-v3 knows Cantonese, transformers.js does not
    if (code) votes[code] = (votes[code] ?? 0) + 1;
  }
  return Object.entries(votes).sort((x, y) => y[1] - x[1])[0]?.[0] ?? "en";
}

function clean(text) {
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/(.{2,40}?)(?:[\s,.!?]*\1){5,}/gu, "$1");  // "go go go go go go go..." loops
  return /\p{L}/u.test(text) ? text : "";  // drop lines with no words (♪, ...)
}

// Transcribe one piece of the movie (Int16 PCM). The last window of a piece is held back and
// joined to the next piece, so no sentence is cut at a piece boundary.
async function transcribePiece({ pcm, start, lang, final }) {
  const fresh = Float32Array.from(pcm, (x) => x / 32768);
  let audio = fresh, offset = start;
  if (carry) {
    audio = new Float32Array(carry.audio.length + fresh.length);
    audio.set(carry.audio);
    audio.set(fresh, carry.audio.length);
    offset = carry.start;
  }
  carry = null;

  const wins = soundWindows(audio);
  if (!final && wins.length) {
    const [a] = wins.pop();
    carry = { audio: audio.slice(Math.floor(a * SR)), start: offset + Math.floor(a * SR) / SR };
  }

  let language = lang || detected;
  if (!language && wins.length) {
    language = detected = await detectLanguage(audio, wins);
    post({ type: "language", lang: language });
  }

  const cues = [];
  for (const [a, b] of wins) {
    const out = await asr(slice(audio, a, b), { return_timestamps: true, language, task: "transcribe" });
    for (const c of out.chunks ?? []) {
      const text = clean(c.text);
      if (!text) continue;
      const s = a + (c.timestamp[0] ?? 0);
      let e = Math.min(b, a + (c.timestamp[1] ?? b - a));
      if (e <= s) e = Math.min(b, s + 1);
      cues.push([offset + s, offset + e, text]);
    }
    post({ type: "progress", at: offset + b, last: cues.at(-1)?.[2] });
  }
  return { cues, lang: language };
}
