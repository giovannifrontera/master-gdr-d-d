# Dashboard multimodale + immagini facoltative — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere immagini facoltative (scene, ritratti, luoghi, oggetti) e relazioni strutturate al plugin master-dnd, e potenziare molto la dashboard di gioco mantenendo la chat.

**Architecture:** Le funzioni pure (validazione immagini, slug, guardia path, normalizzazione relazioni) vivono in un nuovo modulo `lib/media.js` testabile con `node:test`. `index.js` le importa per esporre una rotta statica `/assets/` e un tool `rpg_save_image`. La dashboard (`dashboard.html`, file unico) viene estesa con scena clou, schede complete, grafo relazioni, lightbox e pannelli comprimibili. La skill `rpg-gm.md` viene stretta per rendere la generazione condizionale e mai un errore.

**Tech Stack:** Node ESM (zero dipendenze), `node:test`, `node:assert`, `node:http`, HTML/CSS/JS vanilla.

## Global Constraints

- Nessuna nuova dipendenza npm (`package.json` ha `dependencies: []`, `type: "module"`).
- Tutto retro-compatibile: stati senza i nuovi campi (`mondo.scena`, `relazioni`) devono caricarsi e renderizzarsi senza errori.
- Le immagini sono SEMPRE opzionali: la loro assenza non è mai un errore di gioco.
- Formati immagine ammessi: `png`, `jpeg`/`jpg`, `webp`.
- Path immagine negli stati sempre RELATIVI alla run: `assets/<slug>.<ext>`.
- Cartella asset per-run: `<wikiDataDir>/wiki-works/avventure/<run_id>/assets/`.
- `wikiDataDir = cfg.wikiDataDirectory ?? join(stateDir, "wiki-data")` (vedi `index.js:269`).
- Indentazione e stile dei file esistenti vanno rispettati (index.js: 4 spazi; dashboard.html: compatto).

---

### Task 1: media.js — slug e validazione formato immagine

**Files:**
- Create: `master-dnd-plugin/lib/media.js`
- Test: `master-dnd-plugin/test/media.test.js`

**Interfaces:**
- Produces:
  - `safeSlug(input: string) => string` — minuscole, `[a-z0-9-]`, fallback `"asset"`.
  - `sniffImageExt(buffer: Buffer) => "png"|"jpeg"|"webp"|null` — riconosce il formato dai magic bytes.

- [ ] **Step 1: Write the failing test**

```js
// master-dnd-plugin/test/media.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeSlug, sniffImageExt } from "../lib/media.js";

const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
const JPEG = Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0,0,0,0]), Buffer.from("WEBP")]);

test("safeSlug normalizes names", () => {
  assert.equal(safeSlug("Kaelen il Mago!"), "kaelen-il-mago");
  assert.equal(safeSlug("  "), "asset");
  assert.equal(safeSlug("àéì_ò"), "aei-o");
});

test("sniffImageExt detects formats", () => {
  assert.equal(sniffImageExt(PNG), "png");
  assert.equal(sniffImageExt(JPEG), "jpeg");
  assert.equal(sniffImageExt(WEBP), "webp");
  assert.equal(sniffImageExt(Buffer.from("not an image")), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test master-dnd-plugin/test/media.test.js`
Expected: FAIL — `Cannot find module '../lib/media.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
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
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test master-dnd-plugin/test/media.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add master-dnd-plugin/lib/media.js master-dnd-plugin/test/media.test.js
git commit -m "feat(media): add safeSlug and image format sniffing"
```

---

### Task 2: media.js — decode sorgente immagine + guardia path asset

**Files:**
- Modify: `master-dnd-plugin/lib/media.js`
- Modify: `master-dnd-plugin/test/media.test.js`

**Interfaces:**
- Consumes: `sniffImageExt` (Task 1).
- Produces:
  - `decodeImageSource(source: string, readFileSync: fn) => { buffer: Buffer, ext: string } | null` — accetta data-URI base64, base64 grezzo, o path su disco; ritorna `null` se non è un'immagine valida. `readFileSync` iniettata per testabilità.
  - `resolveAssetPath(assetsDir: string, file: string, join: fn) => string | null` — risolve un nome file dentro `assetsDir`, ritorna `null` se il path esce dalla cartella (traversal) o il nome è sospetto.

- [ ] **Step 1: Write the failing test**

```js
// append to master-dnd-plugin/test/media.test.js
import { decodeImageSource, resolveAssetPath } from "../lib/media.js";
import { join } from "node:path";

const PNG_B64 = "iVBORw0KGgoAAAAA"; // 12 bytes: 89504e470d0a1a0a + 4 zero

test("decodeImageSource handles data-uri and raw base64", () => {
  const a = decodeImageSource("data:image/png;base64," + PNG_B64, null);
  assert.equal(a.ext, "png");
  assert.ok(Buffer.isBuffer(a.buffer));
  const b = decodeImageSource(PNG_B64, null);
  assert.equal(b.ext, "png");
});

test("decodeImageSource reads from disk path", () => {
  const fake = () => Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0,0,0,0,0]);
  const r = decodeImageSource("C:/tmp/foo.jpg", fake);
  assert.equal(r.ext, "jpeg");
});

test("decodeImageSource rejects non-image", () => {
  assert.equal(decodeImageSource("data:text/plain;base64,aGVsbG8=", null), null);
  assert.equal(decodeImageSource("/nope.txt", () => { throw new Error("no"); }), null);
});

test("resolveAssetPath blocks traversal", () => {
  const dir = "/runs/abc/assets";
  assert.equal(resolveAssetPath(dir, "scene.png", join), join(dir, "scene.png"));
  assert.equal(resolveAssetPath(dir, "../secret", join), null);
  assert.equal(resolveAssetPath(dir, "a/b.png", join), null);
  assert.equal(resolveAssetPath(dir, "", join), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test master-dnd-plugin/test/media.test.js`
Expected: FAIL — `decodeImageSource is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// append to master-dnd-plugin/lib/media.js

export function decodeImageSource(source, readFileSync) {
  if (typeof source !== "string" || !source.trim()) return null;
  let buffer = null;
  const dataUri = source.match(/^data:image\/[a-z+]+;base64,(.+)$/i);
  if (dataUri) {
    buffer = Buffer.from(dataUri[1], "base64");
  } else if (/^[A-Za-z0-9+/=\s]+$/.test(source) && source.length > 16 && !/[\\/.]/.test(source.slice(0, 24))) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test master-dnd-plugin/test/media.test.js`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add master-dnd-plugin/lib/media.js master-dnd-plugin/test/media.test.js
git commit -m "feat(media): add image source decoding and asset path guard"
```

---

### Task 3: media.js — normalizzazione relazioni

**Files:**
- Modify: `master-dnd-plugin/lib/media.js`
- Modify: `master-dnd-plugin/test/media.test.js`

**Interfaces:**
- Produces:
  - `normalizeRelations(input: any) => Array<{verso,tipo,intensita,nota}>` — accetta array di relazioni, scarta voci malformate, clampa `intensita` a 1–3, default `tipo:"conoscente"`. Ritorna `[]` se input non valido.

- [ ] **Step 1: Write the failing test**

```js
// append to master-dnd-plugin/test/media.test.js
import { normalizeRelations } from "../lib/media.js";

test("normalizeRelations cleans entries", () => {
  const out = normalizeRelations([
    { verso: "Kaelen", tipo: "alleato", intensita: 5, nota: "x" },
    { verso: "Brunna" },
    { tipo: "nemico" },          // no verso → scartata
    "garbage",                    // → scartata
  ]);
  assert.deepEqual(out, [
    { verso: "Kaelen", tipo: "alleato", intensita: 3, nota: "x" },
    { verso: "Brunna", tipo: "conoscente", intensita: 1, nota: "" },
  ]);
  assert.deepEqual(normalizeRelations(null), []);
  assert.deepEqual(normalizeRelations("nope"), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test master-dnd-plugin/test/media.test.js`
Expected: FAIL — `normalizeRelations is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// append to master-dnd-plugin/lib/media.js

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test master-dnd-plugin/test/media.test.js`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add master-dnd-plugin/lib/media.js master-dnd-plugin/test/media.test.js
git commit -m "feat(media): add relations normalization"
```

---

### Task 4: index.js — relazioni in normalizeCharacter e NPC

**Files:**
- Modify: `master-dnd-plugin/index.js` (import in testa; `normalizeCharacter` ~89-124; tool `rpg_create_character` ~1517-1525)

**Interfaces:**
- Consumes: `normalizeRelations` (Task 3).
- Produces: ogni scheda personaggio normalizzata ha `relazioni: Array` (anche vuoto). Gli NPC in `mondo.npcs_incontrati` ricevono `relazioni` e `ritratto` se passati.

- [ ] **Step 1: Add the import**

In cima a `index.js`, dopo gli import esistenti (dopo la riga `const pluginDir = ...` a riga 13), aggiungi:

```js
import { decodeImageSource, sniffImageExt, safeSlug, resolveAssetPath, normalizeRelations } from "./lib/media.js";
```

- [ ] **Step 2: Wire relations into normalizeCharacter**

In `normalizeCharacter`, prima del `return normalized;` (riga ~123), aggiungi:

```js
    normalized.relazioni = normalizeRelations(normalized.relazioni || normalized.relations || normalized.legami_strutturati);
```

- [ ] **Step 3: Persist NPC ritratto/relazioni**

Nel tool `rpg_create_character`, nel blocco NPC (riga ~1522 dove si costruisce `const npc = {...}`), sostituisci la riga:

```js
                            const npc = { nome: rawParams.character_name, stato: tipo, giocatore: rawParams.giocatore };
```

con:

```js
                            const sheet = state.personaggi[charNameKey] || {};
                            const npc = { nome: rawParams.character_name, stato: tipo, giocatore: rawParams.giocatore };
                            if (sheet.ritratto) npc.ritratto = sheet.ritratto;
                            if (sheet.relazioni && sheet.relazioni.length) npc.relazioni = sheet.relazioni;
                            if (sheet.aspetto) npc.descrizione = npc.descrizione || sheet.aspetto;
```

- [ ] **Step 4: Verify the plugin still loads (syntax check)**

Run: `node --check master-dnd-plugin/index.js`
Expected: no output (exit 0). Se errore di sintassi, correggi.

- [ ] **Step 5: Commit**

```bash
git add master-dnd-plugin/index.js
git commit -m "feat: normalize structured relations on characters and NPCs"
```

---

### Task 5: index.js — rotta statica /assets/

**Files:**
- Modify: `master-dnd-plugin/index.js` (helper area ~312; server routes ~687-710)

**Interfaces:**
- Consumes: `resolveAssetPath` (Task 2), `getActiveRunId`, `wikiDataDir`, `validateRunId`.
- Produces: `GET /assets/<file>` serve il PNG/JPEG/WEBP dalla cartella assets della run attiva; helper `runAssetsDir(runId) => string`.

- [ ] **Step 1: Add runAssetsDir helper**

Dopo `runStateFile` (riga ~312), aggiungi:

```js
        const runAssetsDir = (runId) => join(wikiDataDir, "wiki-works", "avventure", validateRunId(runId), "assets");
        const ASSET_CT = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
```

- [ ] **Step 2: Add the /assets/ route**

Nel server dashboard, dentro `dashServer` (subito prima del blocco `else if (url === "/api/chat")` a riga ~697), aggiungi:

```js
                else if (url.startsWith("/assets/")) {
                    const runId = (() => {
                        try { return JSON.parse(readFileSync(join(stateDir, "active_run.json"), "utf-8")).active_run_id || null; } catch { return null; }
                    })();
                    const file = decodeURIComponent(url.slice("/assets/".length));
                    let resolved = null;
                    try { resolved = runId ? resolveAssetPath(runAssetsDir(runId), file, join) : null; } catch { resolved = null; }
                    if (!resolved || !existsSync(resolved)) { res.statusCode = 404; res.end("not found"); return; }
                    const ext = resolved.split(".").pop().toLowerCase();
                    const ct = ASSET_CT[ext === "jpg" ? "jpeg" : ext];
                    if (!ct) { res.statusCode = 404; res.end("unsupported"); return; }
                    res.setHeader("Content-Type", ct);
                    res.setHeader("Cache-Control", "no-cache");
                    res.end(readFileSync(resolved));
                }
```

Nota: `url` è già `(req.url || "/").split("?")[0]` (riga 687). Assicurati che il nuovo blocco stia tra `/api/state` e `/api/chat`, NON dopo il `else` finale che serve l'HTML.

- [ ] **Step 3: Verify syntax**

Run: `node --check master-dnd-plugin/index.js`
Expected: exit 0.

- [ ] **Step 4: Manual route check**

Crea un file di prova e verifica che la guardia funzioni (senza avviare l'intero plugin):

```bash
node -e "import('./master-dnd-plugin/lib/media.js').then(m=>{const {join}=require('path');console.log(m.resolveAssetPath('/a/assets','x.png',join), m.resolveAssetPath('/a/assets','../e',join))})"
```
Expected: stampa `/a/assets/x.png null` (o equivalente Windows), confermando blocco traversal.

- [ ] **Step 5: Commit**

```bash
git add master-dnd-plugin/index.js
git commit -m "feat: serve per-run image assets via /assets route"
```

---

### Task 6: index.js — tool rpg_save_image

**Files:**
- Modify: `master-dnd-plugin/index.js` (registra un nuovo tool accanto a `rpg_create_character`, dopo il blocco che termina a riga ~1537)

**Interfaces:**
- Consumes: `decodeImageSource`, `safeSlug`, `runAssetsDir`, `getActiveRunId`, `loadState`, `saveState`, `characterKey`.
- Produces: tool `rpg_save_image` che salva un'immagine e registra il riferimento; ritorna `{ status, path }` o errore soft.

- [ ] **Step 1: Register the tool**

Subito dopo la chiusura `}));` del tool `rpg_create_character` (riga ~1537), inserisci:

```js
            // 12b. Tool: rpg_save_image (opzionale, non distruttivo)
            registerWithAlias("rpg_save_image", (ctx) => ({
                name: "rpg_save_image",
                label: "Save Game Image",
                description: "OPZIONALE. Salva un'immagine generata (scena, ritratto, luogo, oggetto) nella cartella assets della run e ne registra il riferimento nello stato. Usalo SOLO se disponi di capacità multimodale e puoi davvero produrre un'immagine. L'assenza di immagini non è mai un errore.",
                parameters: {
                    type: "object",
                    properties: {
                        tipo: { type: "string", enum: ["scena", "ritratto", "luogo", "oggetto"], description: "Tipo di immagine." },
                        target: { type: "string", description: "Nome del PG/NPC (richiesto per tipo=ritratto)." },
                        source: { type: "string", description: "L'immagine: data-URI base64, base64 grezzo, o path su disco." },
                        slug: { type: "string", description: "Nome file opzionale (senza estensione)." },
                        didascalia: { type: "string", description: "Didascalia opzionale (usata per tipo=scena)." },
                        run_id: { type: "string", description: "ID run (opzionale)." }
                    },
                    required: ["tipo", "source"]
                },
                execute: async (_toolCallId, p) => {
                    try {
                        const runId = p.run_id || getActiveRunId(ctx?.sessionKey);
                        if (!runId) return { status: "error", message: "Nessuna run attiva." };
                        const decoded = decodeImageSource(p.source, readFileSync);
                        if (!decoded) return { status: "error", message: "Sorgente non è un'immagine valida (png/jpeg/webp). Immagine ignorata, il gioco continua." };
                        const slug = safeSlug(p.slug || p.target || p.tipo) + "-" + Date.now().toString(36);
                        const fileName = `${slug}.${decoded.ext}`;
                        const dir = runAssetsDir(runId);
                        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                        writeFileSync(join(dir, fileName), decoded.buffer);
                        const rel = `assets/${fileName}`;
                        const state = loadState(runId);
                        if (p.tipo === "scena") {
                            state.mondo = state.mondo || {};
                            state.mondo.scena = { immagine: rel, didascalia: p.didascalia || "", turno: state.turno || 0 };
                        } else if (p.tipo === "ritratto" && p.target) {
                            const key = characterKey(p.target);
                            if (state.personaggi && state.personaggi[key]) state.personaggi[key].ritratto = rel;
                            const npcs = (state.mondo && state.mondo.npcs_incontrati) || [];
                            const npc = npcs.find((n) => characterKey(n.nome) === key);
                            if (npc) npc.ritratto = rel;
                        }
                        saveState(runId, state, ctx?.sessionKey);
                        return { status: "success", path: rel, message: `Immagine salvata: ${rel}` };
                    } catch (err) {
                        return { status: "error", message: `Immagine non salvata (${err.message}). Il gioco continua.` };
                    }
                }
            }));
```

- [ ] **Step 2: Verify syntax**

Run: `node --check master-dnd-plugin/index.js`
Expected: exit 0.

- [ ] **Step 3: Self-check the decode→write flow in isolation**

Run:
```bash
node -e "
import('./master-dnd-plugin/lib/media.js').then(m=>{
  const png='data:image/png;base64,iVBORw0KGgoAAAAA';
  const d=m.decodeImageSource(png,null);
  if(!d||d.ext!=='png') throw new Error('decode failed');
  if(m.decodeImageSource('data:text/plain;base64,aGVsbG8=',null)!==null) throw new Error('should reject');
  console.log('OK decode flow');
});
"
```
Expected: `OK decode flow`.

- [ ] **Step 4: Commit**

```bash
git add master-dnd-plugin/index.js
git commit -m "feat: add optional rpg_save_image tool"
```

---

### Task 7: dashboard — immagine clou di scena + helper asset + lightbox

**Files:**
- Modify: `master-dnd-plugin/dashboard.html` (CSS area ~166-185; `renderScene` ~924-950; render loop ~1020; nuovo markup overlay nel `<body>` ~316)

**Interfaces:**
- Consumes: stato con `mondo.scena.immagine` (opzionale).
- Produces: funzione globale `assetUrl(rel)`, `openLightbox(html)`, markup `#lightbox`, scena con immagine hero.

- [ ] **Step 1: Add lightbox markup**

Dentro `<body>` (dopo `</div>` di chiusura di `.cols`, riga ~362, prima di `<script>`), aggiungi:

```html
<div id="lightbox" class="lightbox" onclick="closeLightbox()"><div class="lightbox-inner" id="lightbox-inner"></div></div>
```

- [ ] **Step 2: Add CSS**

Nel `<style>`, vicino alla sezione Portraits (riga ~166), aggiungi:

```css
.scene-hero{position:relative;border-radius:8px;overflow:hidden;margin-bottom:12px;border:1px solid var(--bdr);cursor:zoom-in}
.scene-hero img{width:100%;max-height:340px;object-fit:cover;display:block}
.scene-hero-cap{position:absolute;left:0;right:0;bottom:0;padding:10px 12px;font-size:.8rem;color:var(--parchment);background:linear-gradient(transparent,rgba(0,0,0,.8))}
.lightbox{display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.92);align-items:center;justify-content:center;cursor:zoom-out;padding:24px}
.lightbox.open{display:flex}
.lightbox-inner{max-width:92vw;max-height:92vh;overflow:auto}
.lightbox-inner img{max-width:90vw;max-height:90vh;object-fit:contain;border-radius:6px}
```

- [ ] **Step 3: Add JS helpers + scene hero**

Vicino alle utilities (dopo `esc` a riga ~375), aggiungi:

```js
function assetUrl(rel){return rel?`http://localhost:${DASH_PORT}/${String(rel).replace(/^\/+/,'')}`:''}
function openLightbox(html){const lb=document.getElementById('lightbox');document.getElementById('lightbox-inner').innerHTML=html;lb.classList.add('open')}
function closeLightbox(){document.getElementById('lightbox').classList.remove('open')}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeLightbox()});
```

In `renderScene` (riga ~935), sostituisci l'apertura `return \`<div class="scene-wrap">` con un blocco che antepone l'immagine hero:

```js
  const scena=mondo.scena||{};
  const heroUrl=scena.immagine?assetUrl(scena.immagine):'';
  const hero=heroUrl?`<div class="scene-hero" onclick="openLightbox('<img src=\\'${esc(heroUrl)}\\'>')">
      <img src="${esc(heroUrl)}" alt="scena">
      ${scena.didascalia?`<div class="scene-hero-cap">${esc(scena.didascalia)}</div>`:''}
    </div>`:'';
  return `<div class="scene-wrap">
    ${hero}
```

(mantieni invariato tutto il resto del template esistente di `renderScene`).

- [ ] **Step 4: Manual verification**

Crea uno stato di prova e apri la dashboard:
```bash
cat > /tmp/scene_check.json <<'EOF'
{"titolo":"Test","turno":3,"sistema":"dnd5e","personaggi":{},"mondo":{"locazione":"Cripta","tempo":"Notte","npcs_incontrati":[],"scena":{"immagine":"assets/x.png","didascalia":"L'altare nero"}}}
EOF
```
Verifica nel browser (con plugin avviato e una run con `mondo.scena.immagine`): l'immagine appare in cima allo Scenario; click → lightbox a tutto schermo; ESC chiude. Senza `scena.immagine`: nessuna immagine, nessun errore in console.

- [ ] **Step 5: Commit**

```bash
git add master-dnd-plugin/dashboard.html
git commit -m "feat(dashboard): scene hero image + lightbox"
```

---

### Task 8: dashboard — scheda completa al centro + selezione party

**Files:**
- Modify: `master-dnd-plugin/dashboard.html` (CSS; nuova `renderSheet(c)`; `renderParty` per selezione ~858; render loop ~1017-1021)

**Interfaces:**
- Consumes: `lastChars`, `charImage`, `charSubtitle`.
- Produces: variabile globale `selectedCharKey`; funzione `selectChar(key)`; `renderSheet(c)` che mostra TUTTI gli attributi.

- [ ] **Step 1: Add selection state + selectChar**

Vicino a `let lastChars` (cerca `lastChars` nel file), aggiungi:

```js
let selectedCharKey=null;
function selectChar(k){selectedCharKey=k;if(window.__lastState)pollRender(window.__lastState)}
```

- [ ] **Step 2: Make party cards clickable**

In `renderParty`, cambia l'apertura della card (riga ~858) da:

```js
    return `<div class="pcard">
```
a:
```js
    return `<div class="pcard ${selectedCharKey===k?'sel':''}" onclick="selectChar('${k.replace(/'/g,"\\'")}')" style="cursor:pointer">
```

Aggiungi CSS (vicino alle altre `.pcard`):
```css
.pcard.sel{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold) inset}
```

- [ ] **Step 3: Add renderSheet**

Dopo `renderPortraits` (riga ~921), aggiungi:

```js
function kvRows(obj){
  return Object.entries(obj||{}).filter(([,v])=>v!=null&&v!=='').map(([k,v])=>{
    let val=Array.isArray(v)?v.join(', '):(typeof v==='object'?JSON.stringify(v):String(v));
    return `<div class="sheet-row"><span class="sheet-k">${esc(k)}</span><span class="sheet-v">${esc(val)}</span></div>`;
  }).join('');
}
function renderSheet(c){
  if(!c)return '';
  const skip=new Set(['nome','giocatore','tipo','ritratto','portrait','avatar','relazioni']);
  const base={};Object.entries(c).forEach(([k,v])=>{if(!skip.has(k))base[k]=v});
  const url=assetUrl(c.ritratto||c.portrait||'');
  const img=url?`<img src="${esc(url)}" alt="${esc(c.nome||'')}" onclick="openLightbox('<img src=\\'${esc(url)}\\'>')" style="cursor:zoom-in">`:charImage(c);
  return `<div class="sheet">
    <div class="sheet-head">
      <div class="sheet-portrait">${img}</div>
      <div><div class="sheet-name">${esc(c.nome||'')}</div>
      <div class="sheet-sub">${esc(charSubtitle(c))}${c.giocatore?' · '+esc(c.giocatore):''}</div></div>
    </div>
    <div class="sheet-body">${kvRows(base)}</div>
  </div>`;
}
```

Aggiungi CSS:
```css
.sheet{background:var(--card);border:1px solid var(--bdr);border-radius:8px;padding:12px;margin-bottom:12px}
.sheet-head{display:flex;gap:12px;align-items:center;margin-bottom:10px}
.sheet-portrait{width:72px;height:96px;border-radius:6px;overflow:hidden;flex-shrink:0}
.sheet-portrait svg,.sheet-portrait img{width:100%;height:100%;object-fit:cover;display:block}
.sheet-name{font-family:'Cinzel',serif;font-size:1.1rem;color:var(--parchment);font-weight:700}
.sheet-sub{font-size:.72rem;color:var(--ash)}
.sheet-row{display:flex;gap:10px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:.76rem}
.sheet-k{flex:0 0 38%;color:var(--gold);text-transform:capitalize}
.sheet-v{flex:1;color:var(--parchment);word-break:break-word}
```

- [ ] **Step 4: Wire into render loop**

Nel polling, salva lo stato e usa la scheda. Sostituisci il blocco `else{ labelEl... renderScene(state) }` (riga ~1017-1021) con:

```js
    }else{
      labelEl.textContent='Scenario';
      chipEl.style.display='none';
      const chars=state.personaggi||{};
      const keys=Object.keys(chars);
      if(selectedCharKey&&!chars[selectedCharKey])selectedCharKey=null;
      if(!selectedCharKey&&keys.length)selectedCharKey=keys[0];
      const sel=selectedCharKey?chars[selectedCharKey]:null;
      centerEl.innerHTML=renderScene(state)+(sel?renderSheet(sel):renderPortraits(chars));
    }
```

E in cima a `pollState`/dopo aver ottenuto `state`, salva il riferimento. Subito dopo `const{state}=await r.json();` (riga ~1000) aggiungi:
```js
    window.__lastState=state;
```
E crea una funzione `pollRender(state)` non necessaria: `selectChar` può richiamare direttamente il rerender chiamando `pollState()` non va bene (rifetch). Sostituisci la riga di `selectChar` dello Step 1 con:
```js
function selectChar(k){selectedCharKey=k;if(window.__lastState)renderFromState(window.__lastState)}
```
e estrai il corpo di rendering: rinomina il blocco dentro `pollState` che parte da `document.getElementById('cname')...` fino alla fine del `else` in una funzione:
```js
function renderFromState(state){
  document.getElementById('cname').textContent=state.titolo||'';
  document.getElementById('tinfo').textContent='Turno '+(state.turno||0)+' · '+(state.sistema||'dnd5e');
  renderParty(state.personaggi||{});
  const comb=state.combattimento;
  const inCombat=comb?.attivo&&comb.ordine_iniziativa?.length>0;
  const centerEl=document.getElementById('center');
  const labelEl=document.getElementById('center-label');
  const chipEl=document.getElementById('rchip');
  if(inCombat){
    labelEl.textContent='Combattimento';chipEl.style.display='';chipEl.textContent='RND '+comb.round;
    centerEl.innerHTML=renderCombat(comb,state.personaggi);
  }else{
    labelEl.textContent='Scenario';chipEl.style.display='none';
    const chars=state.personaggi||{};const keys=Object.keys(chars);
    if(selectedCharKey&&!chars[selectedCharKey])selectedCharKey=null;
    if(!selectedCharKey&&keys.length)selectedCharKey=keys[0];
    const sel=selectedCharKey?chars[selectedCharKey]:null;
    centerEl.innerHTML=renderScene(state)+(sel?renderSheet(sel):renderPortraits(chars));
  }
}
```
e in `pollState` sostituisci tutto quel blocco con:
```js
    window.__lastState=state;
    document.getElementById('sdot').className='dot ok';
    document.getElementById('slabel').textContent='Stato OK';
    renderFromState(state);
```

- [ ] **Step 5: Verify + commit**

Verifica nel browser: clic su una card del party → la card si evidenzia e la scheda completa appare al centro con tutti i campi (stats, hp, ca, inventario, incantesimi, ecc.). Click sul ritratto della scheda → lightbox.

```bash
git add master-dnd-plugin/dashboard.html
git commit -m "feat(dashboard): full character sheet + party selection"
```

---

### Task 9: dashboard — grafo relazioni (SVG)

**Files:**
- Modify: `master-dnd-plugin/dashboard.html` (CSS; nuova `renderRelations(state)`; append in `renderFromState` scene branch)

**Interfaces:**
- Consumes: `state.personaggi[*].relazioni`, `state.mondo.npcs_incontrati[*].relazioni`, fallback `npcs_incontrati[*].stato`.
- Produces: `renderRelations(state) => string` (SVG inline) appeso sotto la scheda.

- [ ] **Step 1: Add renderRelations**

Dopo `renderSheet` (Task 8), aggiungi:

```js
const REL_COLOR={alleato:'#3fa34d',amante:'#d2589c',familiare:'#4aa6c9',mentore:'#c9a227',rivale:'#d08a2c',nemico:'#b53232',conoscente:'#7a7a8a'};
function collectRelations(state){
  const nodes=new Set(),edges=[];
  const add=(from,rels)=>{(rels||[]).forEach(r=>{nodes.add(from);nodes.add(r.verso);edges.push({from,to:r.verso,tipo:r.tipo,intensita:r.intensita,nota:r.nota})})};
  Object.values(state.personaggi||{}).forEach(c=>add(c.nome,c.relazioni));
  ((state.mondo||{}).npcs_incontrati||[]).forEach(n=>{
    if(typeof n!=='object')return;
    if(n.relazioni&&n.relazioni.length)add(n.nome,n.relazioni);
    else if(n.stato&&['alleato','nemico','rivale'].includes(String(n.stato).toLowerCase())){
      // fallback: derive a single edge to nobody-specific is skipped; keep node only
      nodes.add(n.nome);
    }
  });
  return {nodes:[...nodes],edges};
}
function renderRelations(state){
  const {nodes,edges}=collectRelations(state);
  if(!edges.length)return '';
  const cx=180,cy=160,R=120,N=nodes.length;
  const pos={};nodes.forEach((n,i)=>{const a=-Math.PI/2+i*2*Math.PI/N;pos[n]={x:cx+R*Math.cos(a),y:cy+R*Math.sin(a)}});
  const lines=edges.filter(e=>pos[e.from]&&pos[e.to]).map(e=>{
    const p=pos[e.from],q=pos[e.to],col=REL_COLOR[e.tipo]||REL_COLOR.conoscente;
    return `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="${col}" stroke-width="${e.intensita}" opacity=".7"><title>${esc(e.from+' → '+e.to+' ('+e.tipo+')'+(e.nota?': '+e.nota:''))}</title></line>`;
  }).join('');
  const dots=nodes.map(n=>{const p=pos[n];return `<g><circle cx="${p.x}" cy="${p.y}" r="5" fill="#c9a227"/><text x="${p.x}" y="${p.y-9}" text-anchor="middle" font-size="9" fill="#e8d5b0">${esc(n)}</text></g>`}).join('');
  const legend=Object.entries(REL_COLOR).map(([k,v])=>`<span style="color:${v};font-size:.62rem;margin-right:8px">● ${k}</span>`).join('');
  return `<div class="rel-panel"><div class="sheet-sec-title">Relazioni</div>
    <svg viewBox="0 0 360 320" style="width:100%;height:auto">${lines}${dots}</svg>
    <div class="rel-legend">${legend}</div></div>`;
}
```

Aggiungi CSS:
```css
.rel-panel{background:var(--card);border:1px solid var(--bdr);border-radius:8px;padding:12px;margin-bottom:12px}
.sheet-sec-title{font-family:'Cinzel',serif;color:var(--gold);font-size:.85rem;margin-bottom:8px}
.rel-legend{margin-top:6px;display:flex;flex-wrap:wrap;gap:2px}
```

- [ ] **Step 2: Append into render loop**

In `renderFromState`, nel branch `else` (scenario), cambia la riga:
```js
      centerEl.innerHTML=renderScene(state)+(sel?renderSheet(sel):renderPortraits(chars));
```
in:
```js
      centerEl.innerHTML=renderScene(state)+(sel?renderSheet(sel):renderPortraits(chars))+renderRelations(state);
```

- [ ] **Step 3: Manual verification**

Con uno stato in cui un PG ha `relazioni:[{verso:"Kaelen",tipo:"alleato",intensita:2}]`: appare un grafo SVG con nodi e archi colorati; hover sull'arco mostra il tooltip. Senza relazioni: nessun pannello, nessun errore.

- [ ] **Step 4: Commit**

```bash
git add master-dnd-plugin/dashboard.html
git commit -m "feat(dashboard): SVG relations graph"
```

---

### Task 10: dashboard — pannelli comprimibili (chat + colonna destra)

**Files:**
- Modify: `master-dnd-plugin/dashboard.html` (header markup ~318-328; CSS `.cols`; JS toggle)

**Interfaces:**
- Produces: `togglePanel(which)` con persistenza `localStorage`; classi `hide-chat` su `.cols`.

- [ ] **Step 1: Add toggle buttons in header**

In `<header class="hdr">`, dentro `.hdr-info` (riga ~327, dopo l'ultimo `<span>`), aggiungi:

```html
    <button class="panel-toggle" id="toggle-chat" onclick="togglePanel('chat')" title="Mostra/nascondi chat">💬</button>
```

- [ ] **Step 2: Add CSS**

```css
.panel-toggle{background:var(--card);border:1px solid var(--bdr);color:var(--parchment);border-radius:6px;padding:3px 8px;cursor:pointer;font-size:.9rem}
.panel-toggle.off{opacity:.4}
.cols.hide-chat{grid-template-columns:var(--party-w,260px) 1fr}
.cols.hide-chat .col:last-child{display:none}
```

(Adatta i nomi: verifica come `.cols` definisce `grid-template-columns` nel CSS esistente e replica le prime due colonne in `.hide-chat`. Se `.cols` usa `flex`, usa invece `.cols.hide-chat .col:last-child{display:none}` e lascia che la scena si allarghi con `flex:1`.)

- [ ] **Step 3: Add toggle JS**

Vicino agli helper, aggiungi:

```js
function togglePanel(which){
  const cols=document.querySelector('.cols');
  const on=cols.classList.toggle('hide-'+which);
  document.getElementById('toggle-'+which)?.classList.toggle('off',on);
  try{localStorage.setItem('dnd-hide-'+which,on?'1':'0')}catch{}
}
(function restorePanels(){
  ['chat'].forEach(w=>{
    let v='0';try{v=localStorage.getItem('dnd-hide-'+w)||'0'}catch{}
    if(v==='1'){document.querySelector('.cols').classList.add('hide-'+w);document.getElementById('toggle-'+w)?.classList.add('off')}
  });
})();
```

(Esegui `restorePanels` dopo che il DOM è pronto: posizionalo a fine `<script>` o dentro un `window.addEventListener('DOMContentLoaded',...)` se lo script è nell'`<head>`. Qui lo script è a fine body, quindi la IIFE va bene.)

- [ ] **Step 4: Manual verification**

Click su 💬: la chat si nasconde, la scena si allarga; ricaricando la pagina resta nascosta (localStorage). Click di nuovo: riappare.

- [ ] **Step 5: Commit**

```bash
git add master-dnd-plugin/dashboard.html
git commit -m "feat(dashboard): collapsible chat panel with persistence"
```

---

### Task 11: skill rpg-gm.md — stringere immagini + relazioni

**Files:**
- Modify: `master-dnd-plugin/wiki-backend/skills/rpg-gm.md` (sezione "Schede personaggio e NPC" ~46-67; "Tool policy" ~111-119)

**Interfaces:** nessuna (documentazione/istruzioni).

- [ ] **Step 1: Replace the visual-assets paragraph**

Sostituisci le righe ~64-67 (da `Per asset visivi usa path per-run...` fino a `...richiesta esplicita del giocatore.`) con:

```markdown
### Immagini (FACOLTATIVE)

Le immagini sono opzionali e arricchiscono il gioco, ma non sono mai obbligatorie.

- Genera un'immagine SOLO se disponi di reale capacità multimodale e puoi
  produrre l'immagine. Altrimenti **non** tentare, **non** scusarti e **non**
  menzionare la mancanza: gioca normalmente.
- Per salvare un'immagine usa SEMPRE il tool `rpg_save_image` (mai costruire
  path a mano). Passa `tipo` (`scena`/`ritratto`/`luogo`/`oggetto`), il
  `source` (data-URI base64, base64 o path) e, per i ritratti, `target` (nome
  PG/NPC). Il tool valida formato e path e aggiorna lo stato.
- Quando generare, con parsimonia: cambio di scena clou, comparsa di un NPC
  importante, ritratto di un PG, oggetto chiave, o richiesta esplicita del
  giocatore.
- L'assenza di immagini non è mai un errore di gioco.
```

- [ ] **Step 2: Add structured relations requirement**

Nella sezione "Schede personaggio e NPC", dopo la riga `- legami: relazioni con PG/NPC/fazioni` (riga ~58), aggiungi:

```markdown
- `relazioni`: array strutturato per la dashboard, oltre ai `legami` narrativi.
  Ogni voce: `{ "verso": "Nome", "tipo": "alleato|rivale|amante|nemico|familiare|mentore|conoscente", "intensita": 1-3, "nota": "breve" }`.
  Compilalo quando crei o aggiorni un PG o un NPC rilevante.
```

- [ ] **Step 3: Add rpg_save_image to Tool policy**

Nella sezione "Tool policy" (~111-119), dopo la riga di `rpg_narrate`, aggiungi:

```markdown
- `rpg_save_image`: opzionale, solo con capacità multimodale reale; salva
  scene/ritratti e aggiorna la dashboard. Mai un obbligo.
```

- [ ] **Step 4: Verify**

Run: `grep -n "rpg_save_image\|relazioni\|FACOLTATIVE" master-dnd-plugin/wiki-backend/skills/rpg-gm.md`
Expected: le nuove righe sono presenti.

- [ ] **Step 5: Commit**

```bash
git add master-dnd-plugin/wiki-backend/skills/rpg-gm.md
git commit -m "docs(skill): tighten optional image rules and structured relations"
```

---

## Self-Review

**Spec coverage:**
- §1.1 scena → Task 6 (write) + Task 7 (render). ✓
- §1.2 relazioni → Task 3 (normalize) + Task 4 (persist) + Task 9 (graph) + Task 11 (skill). ✓
- §1.3 ritratti NPC → Task 4 + Task 6. ✓
- §1.4 formato/posizione → Task 1/2/5/6. ✓
- §2.1 rotta /assets → Task 5. ✓
- §2.2 rpg_save_image → Task 6. ✓
- §2.3 normalizzazione relazioni → Task 3/4. ✓
- §3 layout (party/scena/chat, scheda completa, galleria, combat) → Task 7/8/9. ✓
- §3.5 lightbox + pannelli comprimibili → Task 7 (lightbox) + Task 10 (toggle). ✓
- §4 skill → Task 11. ✓
- §6 verifica → self-check in Task 1/2/3/6 + verifica manuale UI. ✓

**Placeholder scan:** nessun TBD/TODO; codice completo in ogni step. ✓

**Type consistency:** `safeSlug`, `sniffImageExt`, `decodeImageSource`, `resolveAssetPath`, `normalizeRelations`, `runAssetsDir`, `assetUrl`, `renderSheet`, `renderRelations`, `renderFromState`, `togglePanel` usati con firme coerenti tra i task. ✓

**Nota operativa:** i Task 7–10 toccano lo stesso file (`dashboard.html`) in punti vicini; eseguirli in ordine. Il Task 8 introduce `renderFromState`/`window.__lastState` su cui si appoggiano Task 9 e 10.
