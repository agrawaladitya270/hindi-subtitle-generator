// Subtitle text -> Hindi with Google Translate (same batching as cli/hindi_subtitles.py).

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Google Translate's free endpoint. One `q` per subtitle, so lines are never merged.
async function googleTranslate(lines, signal) {
  const body = new URLSearchParams();
  for (const line of lines) body.append("q", line);
  const r = await fetch("https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=hi",
                        { method: "POST", body, signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const items = typeof data === "string" ? [data] : data;
  return items.map((x) => (typeof x === "string" ? x : Array.isArray(x) ? String(x[0] ?? "") : ""));
}

export async function translateToHindi(lines, { onProgress, signal } = {}) {
  async function call(chunk) {
    for (const wait of [2, 5, 15, null]) {  // retry with pauses
      try {
        return await googleTranslate(chunk, signal);
      } catch (e) {
        if (signal?.aborted) throw e;
        if (wait === null) throw new Error(`Google Translate failed: ${e.message || e}`);
        await sleep(wait);
      }
    }
  }

  const out = [];
  let i = 0;
  while (i < lines.length) {
    // Send ~1000 characters per request, one subtitle per line.
    const chunk = [];
    let size = 0;
    while (i < lines.length && (!chunk.length || size + lines[i].length < 1000)) {
      chunk.push(lines[i]);
      size += lines[i].length + 1;
      i++;
    }
    let parts;
    try {
      parts = await call(chunk);
    } catch (e) {
      if (signal?.aborted) throw e;
      parts = [];
    }
    if (parts.length !== chunk.length) {  // line count changed -> do this chunk line by line
      parts = [];
      for (const line of chunk) parts.push((await call([line]))[0] ?? "");
    }
    chunk.forEach((orig, k) => out.push(parts[k].trim() || orig));  // keep original if empty
    onProgress?.(i / lines.length);
    await sleep(0.5);  // be gentle with the free endpoint
  }
  return out;
}
