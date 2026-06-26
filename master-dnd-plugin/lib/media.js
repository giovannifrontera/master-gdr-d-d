// master-dnd-plugin/lib/media.js

export function safeSlug(input) {
  const s = String(input || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "asset";
}

export function sniffImageExt(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

export function decodeImageSource(source, readFileSync) {
  if (typeof source !== "string" || !source.trim()) return null;
  let buffer = null;
  const dataUri = source.match(/^data:image\/[a-z+]+;base64,(.+)$/i);
  if (dataUri) {
    buffer = Buffer.from(dataUri[1], "base64");
  } else if (/^[A-Za-z0-9+/=\s]+$/.test(source) && source.length >= 16 && !/[\\/.]/.test(source.slice(0, 24))) {
    // looks like raw base64 (no path separators near the start)
    try { buffer = Buffer.from(source.replace(/\s+/g, ""), "base64"); } catch { buffer = null; }
  } else {
    // treat as disk path
    try { buffer = readFileSync ? readFileSync(source) : null; } catch { return null; }
  }
  if (!buffer || !buffer.length) return null;
  const ext = sniffImageExt(buffer);
  return ext ? { buffer, ext } : null;
}

export function resolveAssetPath(assetsDir, file, join) {
  if (typeof file !== "string" || !file || file.includes("/") || file.includes("\\")) return null;
  if (file.includes("..") || file.startsWith(".")) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(file)) return null;
  return join(assetsDir, file);
}

export function normalizeRelations(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const r of input) {
    if (!r || typeof r !== "object") continue;
    const verso = String(r.verso || r.target || r.nome || "").trim();
    if (!verso) continue;
    let intensita = Number(r.intensita ?? r.intensity ?? 1);
    if (!Number.isFinite(intensita)) intensita = 1;
    intensita = Math.max(1, Math.min(3, Math.round(intensita)));
    out.push({
      verso,
      tipo: String(r.tipo || r.type || "conoscente").trim().toLowerCase() || "conoscente",
      intensita,
      nota: String(r.nota || r.note || "").trim(),
    });
  }
  return out;
}
