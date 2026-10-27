// SRT reading, writing and line splitting (same rules as cli/hindi_subtitles.py).

export function fmtTime(sec) {
  let ms = Math.round(Math.max(sec, 0) * 1000);
  const h = Math.floor(ms / 3_600_000); ms %= 3_600_000;
  const m = Math.floor(ms / 60_000); ms %= 60_000;
  const s = Math.floor(ms / 1000); ms %= 1000;
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

// UTF-8 with BOM, so players on Windows / TVs read Hindi correctly
export function srtBlob(cues) {
  const body = cues
    .map(([start, end, text], i) => `${i + 1}\r\n${fmtTime(start)} --> ${fmtTime(end)}\r\n${text.replace(/\n/g, "\r\n")}\r\n\r\n`)
    .join("");
  return new Blob(["﻿" + body], { type: "application/x-subrip;charset=utf-8" });
}

const TIME_RE = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/;

export async function readSrt(file) {
  const bytes = await file.arrayBuffer();
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    raw = new TextDecoder("windows-1252").decode(bytes);  // old non-UTF-8 .srt files
  }
  raw = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const cues = [];
  for (const block of raw.trim().split(/\n\s*\n/)) {
    const lines = block.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const t = TIME_RE.exec(lines[i]);
      if (!t) continue;
      const [h1, m1, s1, ms1, h2, m2, s2, ms2] = t.slice(1).map(Number);
      const text = lines.slice(i + 1).map((x) => x.trim()).filter(Boolean).join(" ")
        .replace(/<[^>]*>|\{[^}]*\}/g, "").trim();  // drop <i>, {\an8} tags
      if (text) {
        cues.push([h1 * 3600 + m1 * 60 + s1 + ms1 / 1000,
                   h2 * 3600 + m2 * 60 + s2 + ms2 / 1000, text]);
      }
      break;
    }
  }
  return cues;
}

// Same result as Python's textwrap.wrap(text, width) for subtitle text.
function wrap(text, width) {
  const lines = [];
  let cur = "";
  for (let w of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + w.length <= width) { cur += " " + w; continue; }
    if (cur && w.length <= width) { lines.push(cur); cur = w; continue; }
    if (cur) {  // word longer than a line: fill the current line first
      const room = width - cur.length - 1;
      if (room > 0) { cur += " " + w.slice(0, room); w = w.slice(room); }
      lines.push(cur);
    }
    while (w.length > width) { lines.push(w.slice(0, width)); w = w.slice(width); }
    cur = w;
  }
  if (cur) lines.push(cur);
  return lines;
}

// Max 2 lines on screen. Longer text is split into several cues over the same time.
export function splitCue(start, end, text, width = 42) {
  const lines = wrap(text, width);
  if (!lines.length) return [];
  const groups = [];
  for (let k = 0; k < lines.length; k += 2) groups.push(lines.slice(k, k + 2).join("\n"));
  const total = groups.reduce((n, g) => n + g.length, 0);
  const cues = [];
  let t = start;
  for (const g of groups) {
    const d = (end - start) * g.length / total;
    cues.push([t, t + d, g]);
    t += d;
  }
  return cues;
}
