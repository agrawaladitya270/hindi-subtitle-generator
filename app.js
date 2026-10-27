// Hindi Subs: the main flow of hindi_subs.py, in the browser.
import { FFmpeg } from "./vendor/ffmpeg/index.js";
import { readSrt, srtBlob, splitCue, fmtTime, translateToHindi } from "./hindi_subs.js";

const MODELS = {
  "small": "onnx-community/whisper-small",
  "medium": "onnx-community/whisper-medium-ONNX",
  "large-v3-turbo": "onnx-community/whisper-large-v3-turbo",
  "large-v3": "onnx-community/whisper-large-v3-ONNX",
};
const MODEL_LABELS = {
  "small": "small (fast)",
  "medium": "medium",
  "large-v3-turbo": "large-v3-turbo (good + fast)",
  "large-v3": "large-v3 (best, slowest)",
};
// Approximate download in MB: [GPU with fp16, GPU without fp16, CPU]
const MODEL_MB = { "small": [410, 590, 250], "medium": [1080, 680, 990], "large-v3-turbo": [1610, 760, 1090], "large-v3": [2070, 1220, 1820] };

const LANGS = "en English,zh Chinese,de German,es Spanish,ru Russian,ko Korean,fr French,ja Japanese,pt Portuguese,tr Turkish,pl Polish,ca Catalan,nl Dutch,ar Arabic,sv Swedish,it Italian,id Indonesian,hi Hindi,fi Finnish,vi Vietnamese,he Hebrew,uk Ukrainian,el Greek,ms Malay,cs Czech,ro Romanian,da Danish,hu Hungarian,ta Tamil,no Norwegian,th Thai,ur Urdu,hr Croatian,bg Bulgarian,lt Lithuanian,la Latin,mi Maori,ml Malayalam,cy Welsh,sk Slovak,te Telugu,fa Persian,lv Latvian,bn Bengali,sr Serbian,az Azerbaijani,sl Slovenian,kn Kannada,et Estonian,mk Macedonian,br Breton,eu Basque,is Icelandic,hy Armenian,ne Nepali,mn Mongolian,bs Bosnian,kk Kazakh,sq Albanian,sw Swahili,gl Galician,mr Marathi,pa Punjabi,si Sinhala,km Khmer,sn Shona,yo Yoruba,so Somali,af Afrikaans,oc Occitan,ka Georgian,be Belarusian,tg Tajik,sd Sindhi,gu Gujarati,am Amharic,yi Yiddish,lo Lao,uz Uzbek,fo Faroese,ht Haitian Creole,ps Pashto,tk Turkmen,nn Nynorsk,mt Maltese,sa Sanskrit,lb Luxembourgish,my Myanmar,bo Tibetan,tl Tagalog,mg Malagasy,as Assamese,tt Tatar,haw Hawaiian,ln Lingala,ha Hausa,ba Bashkir,jw Javanese,su Sundanese"
  .split(",").map((s) => [s.slice(0, s.indexOf(" ")), s.slice(s.indexOf(" ") + 1)]);

const FFMPEG_CORE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/";
const SR = 16000;
const PIECE = Number(new URLSearchParams(location.search).get("piece")) || 600;  // seconds of audio read at a time

const $ = (id) => document.getElementById(id);
const mb = (bytes) => Math.round(bytes / 1e6);
const isSubs = (f) => /\.(srt|vtt)$/i.test(f.name);

let gpu = null;        // { f16 } when WebGPU works
let file = null;
let media = null;      // { duration, tracks } of the chosen movie
let job = null;        // AbortController of the running job
let result = null;     // { cues, lang, base } kept so translation can be retried
const urls = [];

// ---------------- UI helpers ----------------

function log(line) {
  $("log").textContent += line + "\n";
  $("log").scrollTop = $("log").scrollHeight;
}
function status(text, err = false) {
  $("status").textContent = text;
  $("status").classList.toggle("err", err);
}
function bar(fraction) {  // null = busy without a known amount
  $("bar").parentElement.classList.toggle("indeterminate", fraction == null);
  $("bar").style.width = fraction == null ? "" : `${Math.min(100, fraction * 100).toFixed(1)}%`;
}
function step(name, state) {
  const li = document.querySelector(`[data-step="${name}"]`);
  li.classList.remove("active", "done");
  if (state) li.classList.add(state);
}
function duration(sec) {
  sec = Math.round(sec);
  if (sec < 60) return `${sec} s`;
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}
function addDownload(name, blob, label, main = false) {
  const url = URL.createObjectURL(blob);
  urls.push(url);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.className = main ? "main" : "";
  a.innerHTML = `<b></b><span></span>`;
  a.querySelector("b").textContent = `⬇ ${name}`;
  a.querySelector("span").textContent = label;
  $("downloads").append(a);
  if (main) a.click();
}
function saveOptions() {
  try { localStorage.setItem("hindi-subs", JSON.stringify({ model: $("model").value, cpu: $("cpu").checked })); } catch {}
}
function loadOptions() {
  try { return JSON.parse(localStorage.getItem("hindi-subs")) ?? {}; } catch { return {}; }
}

// ---------------- audio reading (ffmpeg.wasm) ----------------

let ffPromise = null, mounted = null;
const ffLog = [];

async function fetchBlobURL(url, type, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed (${r.status}): ${url}`);
  const total = Number(r.headers.get("content-length")) || 0;
  const reader = r.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress?.(got, Math.max(total, got));
  }
  return URL.createObjectURL(new Blob(parts, { type }));
}

function getFFmpeg() {
  ffPromise ??= (async () => {
    const ff = new FFmpeg();
    ff.on("log", ({ message }) => { ffLog.push(message); if (ffLog.length > 500) ffLog.shift(); });
    const coreURL = await fetchBlobURL(FFMPEG_CORE + "ffmpeg-core.js", "text/javascript");
    const wasmURL = await fetchBlobURL(FFMPEG_CORE + "ffmpeg-core.wasm", "application/wasm",
      (got, total) => fileInfo(`Loading the audio reader… ${mb(got)} / ${mb(total)} MB (first time only)`));
    await ff.load({ coreURL, wasmURL });
    await ff.createDir("/in");
    return ff;
  })();
  ffPromise.catch(() => { ffPromise = null; });
  return ffPromise;
}

async function mount(ff, f) {
  if (mounted === f) return;
  if (mounted) await ff.unmount("/in");
  mounted = null;
  if (!(await ff.mount("WORKERFS", { files: [f] }, "/in"))) throw new Error("This browser cannot read local files.");
  mounted = f;
}

// Duration and audio tracks of the movie.
async function probe(f) {
  const ff = await getFFmpeg();
  await mount(ff, f);
  ffLog.length = 0;
  await ff.exec(["-hide_banner", "-i", `/in/${f.name}`]);
  const text = ffLog.join("\n");
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const tracks = [...text.matchAll(/Stream #\d+:\d+(?:\[\w+\])?(?:\((\w+)\))?: Audio: ([^\n,]*)/g)]
    .map((m) => ({ lang: m[1] && m[1] !== "und" ? m[1] : "?", codec: m[2].trim().split(" ")[0] }));
  if (!tracks.length) {
    throw new Error(/Audio:|Video:/.test(text) || /Duration:/.test(text)
      ? "No audio track in this file."
      : "Cannot read this file as video/audio.");
  }
  return { duration: d ? d[1] * 3600 + d[2] * 60 + Number(d[3]) : 0, tracks };
}

// One piece of one audio track as 16 kHz mono Int16. Empty at the end of the movie.
async function readPiece(ff, f, track, start) {
  await ff.exec(["-hide_banner", "-nostdin", "-ss", String(start), "-t", String(PIECE), "-i", `/in/${f.name}`,
                 "-map", `0:a:${track}`, "-vn", "-sn", "-dn", "-ac", "1", "-ar", String(SR), "-f", "s16le", "/piece.pcm"]);
  let data = new Uint8Array(0);
  try {
    data = await ff.readFile("/piece.pcm");
    await ff.deleteFile("/piece.pcm");
  } catch {}
  return new Int16Array(data.buffer, data.byteOffset, data.byteLength >> 1);
}

// ---------------- 1. speech -> text ----------------

class Whisper {
  constructor(onEvent) {
    this.worker = new Worker(new URL("./whisper-worker.js", import.meta.url), { type: "module" });
    this.pending = new Map();
    this.next = 0;
    this.worker.onmessage = ({ data }) => {
      if (data.id === undefined) return onEvent(data);
      const p = this.pending.get(data.id);
      this.pending.delete(data.id);
      data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
    };
    this.worker.onerror = (e) => this.fail(new Error(e.message || "Speech-to-text stopped (out of memory?)"));
  }
  call(msg, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = this.next++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }
  fail(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
  terminate() {
    this.worker.terminate();
    this.fail(new DOMException("Stopped", "AbortError"));
  }
}

function dtypeFor(model, device) {
  if (device === "wasm") return { encoder_model: "q8", decoder_model_merged: "q8" };
  const encoder = gpu.f16 ? "fp16" : model === "small" ? "fp32" : "q4";
  return { encoder_model: encoder, decoder_model_merged: "q4" };
}

async function transcribe(device, { model, lang, track }, signal) {
  const total = media.duration;
  let t0 = 0, startAt = 0;
  const whisper = new Whisper((ev) => {
    if (ev.type === "download") {
      bar(ev.loaded / ev.total);
      status(`Loading the model: ${mb(ev.loaded)} / ${mb(ev.total)} MB (downloaded only the first time)`);
    } else if (ev.type === "language") {
      log(`Audio language: ${ev.lang}`);
    } else if (ev.type === "progress") {
      if (!t0) { t0 = performance.now(); startAt = ev.at; }
      const rate = (ev.at - startAt) / ((performance.now() - t0) / 1000);  // movie seconds per second
      const left = total && rate > 0 ? ` · about ${duration((total - ev.at) / rate)} left` : "";
      bar(total ? ev.at / total : null);
      status(`Speech-to-text: ${total ? Math.floor(ev.at / total * 100) + "%" : fmtTime(ev.at).slice(0, 8)}${left}`
             + (ev.last ? `\n“${ev.last}”` : ""));
    }
  });
  const stop = () => whisper.terminate();
  signal.addEventListener("abort", stop);
  try {
    step("model", "active");
    bar(null);
    status("Loading Whisper…");
    log(`Loading Whisper '${model}' on ${device === "webgpu" ? "GPU" : "CPU"} (first run downloads the model)...`);
    await whisper.call({ type: "load", model: MODELS[model], device, dtype: dtypeFor(model, device) });
    step("model", "done");
    step("asr", "active");
    bar(0);
    status("Speech-to-text: starting…");

    const ff = await getFFmpeg();
    await mount(ff, file);
    const cues = [];
    let detected = lang, start = 0;
    let next = readPiece(ff, file, track, 0);
    for (;;) {
      const pcm = await next;
      if (start === 0 && !pcm.length) throw new Error("Could not read any audio.");
      const more = pcm.length > 0;
      if (more) next = readPiece(ff, file, track, start + PIECE);  // read ahead while Whisper works
      const res = await whisper.call({ type: "piece", pcm, start, lang, final: !more }, [pcm.buffer]);
      cues.push(...res.cues);
      detected = res.lang ?? detected;
      if (!more) break;
      start += PIECE;
    }
    step("asr", "done");
    log(`Speech-to-text: ${cues.length} lines, length ${Math.round((total || start) / 60)} min`);
    return { cues: mergeRepeats(cues), lang: detected };
  } finally {
    signal.removeEventListener("abort", stop);
    whisper.terminate();
  }
}

// The same line said again right away is usually Whisper repeating itself: keep one.
function mergeRepeats(cues) {
  const out = [];
  for (const c of cues) {
    const prev = out.at(-1);
    if (prev && prev[2] === c[2] && c[0] - prev[1] < 1) prev[1] = Math.max(prev[1], c[1]);
    else out.push([...c]);
  }
  return out;
}

async function speechToText(signal) {
  const opts = { model: $("model").value, lang: $("lang").value || null, track: Number($("track").value) };
  if (media.tracks.length > 1) {
    log(`Audio tracks: ${media.tracks.map((t, i) => `${i}=${t.lang}`).join(", ")}  -> using ${opts.track}`);
  }
  const useGpu = gpu && !$("cpu").checked;
  if (useGpu) {
    try {
      return await transcribe("webgpu", opts, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      log(`GPU failed: ${e.message}\nRetrying on CPU (slower). Tick "Don't use the GPU" to skip the GPU next time.`);
      step("model", null);
      step("asr", null);
    }
  }
  return transcribe("wasm", opts, signal);
}

// ---------------- 2. text -> Hindi, and save ----------------

async function translateAndSave(signal) {
  const { cues, lang, base } = result;
  $("retry").hidden = true;
  step("tr", "active");
  bar(0);
  status("Translating to Hindi…");
  const texts = cues.map((c) => c[2].replace(/\n/g, " "));
  let hindi;
  try {
    hindi = lang === "hi" ? texts : await translateToHindi(texts, {
      signal,
      onProgress: (f) => { bar(f); status(`Translating to Hindi: ${Math.floor(f * 100)}%`); },
    });
  } catch (e) {
    if (signal.aborted) throw e;
    $("retry").hidden = false;
    throw new Error(`${e.message}\nWait a few minutes and press “Retry translation” (speech-to-text is not repeated).`);
  }
  const final = [];
  cues.forEach(([start, end], k) => final.push(...splitCue(start, end, hindi[k])));
  const name = `${base}.hi.srt`;
  addDownload(name, srtBlob(final), "Hindi subtitles", true);
  step("tr", "done");
  bar(1);
  status(`Done: ${name}  (${final.length} subtitles)\nPut it next to the movie with the same name, or load it in your player.`);
  log(`Done: ${name}  (${final.length} subtitles)`);
  showPreview(cues, hindi);
}

function showPreview(cues, hindi) {
  const rows = $("rows");
  rows.textContent = "";
  cues.slice(0, 500).forEach(([start], k) => {
    const tr = rows.insertRow();
    tr.insertCell().textContent = fmtTime(start).slice(0, 8);
    tr.insertCell().textContent = cues[k][2];
    tr.insertCell().textContent = hindi[k];
  });
  $("preview").hidden = false;
}

// ---------------- main ----------------

async function run(retryTranslation = false) {
  const ctl = new AbortController();
  job = ctl;
  setBusy(true);
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  try {
    if (!retryTranslation) {
      result = null;
      $("downloads").textContent = "";
      $("log").textContent = "";
      $("preview").hidden = true;
      for (const s of ["model", "asr", "tr"]) step(s, null);
      const subs = isSubs(file);
      document.querySelector('[data-step="model"]').hidden = subs;
      document.querySelector('[data-step="asr"]').hidden = subs;

      let base = file.name.replace(/\.[^.]+$/, "");  // movie.mp4 -> movie
      let cues, lang = null;
      if (subs) {
        cues = await readSrt(file);
        if (/\.[a-z]{2}$/.test(base)) base = base.slice(0, -3);  // movie.en.srt -> movie
        log(`Read ${cues.length} subtitles from ${file.name}`);
      } else {
        ({ cues, lang } = await speechToText(ctl.signal));
      }
      if (!cues.length) throw new Error("No speech / subtitles found.");
      result = { cues, lang, base };
      if (lang) {  // offer original-language subtitles first, so this slow step is never lost
        addDownload(`${base}.${lang}.srt`, srtBlob(cues), "Original language");
        log(`Saved original-language subtitles: ${base}.${lang}.srt`);
      }
    }
    await translateAndSave(ctl.signal);
  } catch (e) {
    if (ctl.signal.aborted) {
      status("Stopped.");
      bar(0);
    } else {
      console.error(e);
      status(e.message, true);
      log(`Error: ${e.message}`);
    }
  } finally {
    job = null;
    setBusy(false);
    wakeLock?.release().catch(() => {});
  }
}

function setBusy(busy) {
  $("work").hidden = false;
  $("stop").hidden = !busy;
  $("start").disabled = busy || !file;
  $("file").disabled = busy;
  for (const id of ["model", "lang", "track", "cpu"]) $(id).disabled = busy;
}

function fileInfo(text, err = false) {
  $("fileinfo").hidden = false;
  $("fileinfo").textContent = text;
  $("fileinfo").classList.toggle("err", err);
}

async function chooseFile(f) {
  if (!f || job) return;
  file = f;
  media = null;
  $("start").disabled = true;
  const subs = isSubs(f);
  $("options").hidden = subs;
  $("device").hidden = subs;
  const size = f.size > 1e9 ? `${(f.size / 1e9).toFixed(2)} GB` : `${Math.max(1, mb(f.size))} MB`;
  if (subs) {
    fileInfo(`${f.name} · subtitles: will be translated to Hindi (no speech-to-text)`);
    $("start").disabled = false;
    return;
  }
  fileInfo(`${f.name} · ${size} · reading…`);
  try {
    const info = await probe(f);
    if (file !== f) return;
    media = info;
    $("track").innerHTML = "";
    info.tracks.forEach((t, i) => $("track").add(new Option(`${i + 1}. ${t.lang === "?" ? "" : t.lang + " · "}${t.codec}`, i)));
    $("track").disabled = info.tracks.length < 2;
    fileInfo(`${f.name} · ${size}${info.duration ? ` · ${duration(info.duration)}` : ""} · `
             + `${info.tracks.length} audio track${info.tracks.length > 1 ? "s" : ""}`);
    $("start").disabled = false;
  } catch (e) {
    if (file === f) fileInfo(`${f.name}: ${e.message}`, true);
  }
}

function modelOptions() {
  const k = gpu && !$("cpu").checked ? (gpu.f16 ? 0 : 1) : 2;
  const current = $("model").value;
  $("model").innerHTML = "";
  for (const id of Object.keys(MODELS)) {
    const size = MODEL_MB[id][k];
    $("model").add(new Option(`${MODEL_LABELS[id]} · ${size >= 1000 ? (size / 1000).toFixed(1) + " GB" : size + " MB"}`, id));
  }
  $("model").value = current || "large-v3-turbo";
  const vendor = gpu?.vendor ? ` (${gpu.vendor[0].toUpperCase()}${gpu.vendor.slice(1)})` : "";
  $("device").textContent = !gpu
    ? "No WebGPU in this browser: speech-to-text runs on the CPU (slow for long movies; “small” is fastest). Chrome or Edge with a graphics card is much faster."
    : $("cpu").checked ? "Speech-to-text will run on the CPU (slower)."
    : gpu.vendor === "intel"
      ? `Graphics found${vendor}: speech-to-text runs on the GPU. Laptop with an NVIDIA or AMD card too? Set this browser to “High performance” in Windows Settings › System › Display › Graphics. It is several times faster.`
      : `Graphics card found${vendor}: speech-to-text runs on the GPU.`;
}

async function init() {
  for (const [code, name] of LANGS) $("lang").add(new Option(`${name} (${code})`, code));
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter) gpu = { f16: adapter.features.has("shader-f16"), vendor: adapter.info?.vendor ?? "" };
  } catch {}
  const saved = loadOptions();
  $("cpu").checked = !!saved.cpu;
  $("model").innerHTML = `<option value="${saved.model in MODELS ? saved.model : gpu ? "large-v3-turbo" : "small"}"></option>`;
  modelOptions();

  $("file").addEventListener("change", () => chooseFile($("file").files[0]));
  const drop = $("drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    chooseFile(e.dataTransfer.files[0]);
  });
  $("cpu").addEventListener("change", () => { modelOptions(); saveOptions(); });
  $("model").addEventListener("change", saveOptions);
  $("start").addEventListener("click", () => run());
  $("retry").addEventListener("click", () => run(true));
  $("stop").addEventListener("click", () => job?.abort());
  window.addEventListener("beforeunload", (e) => { if (job) e.preventDefault(); });
}

init();
