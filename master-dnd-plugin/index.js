import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { existsSync, writeFileSync, readFileSync, mkdirSync, appendFileSync, readdirSync, rmSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const execFileAsync = promisify(execFile);
let _dashServer = null;
// Resolve current plugin directory (works for both ES module and compiled index.js)
const pluginDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const NodeWebSocket = require(join(pluginDir, "node_modules", "openclaw", "node_modules", "ws"));
const wikiBackendDir = join(pluginDir, "wiki-backend");
import { decodeImageSource, sniffImageExt, safeSlug, resolveAssetPath, normalizeRelations } from "./lib/media.js";
function parseAndRoll(expression, adv = "none", explode = false) {
    const normalizedAdv = adv.toLowerCase().trim();
    const advantageMode = normalizedAdv === "vantaggio" || normalizedAdv === "advantage" ? "advantage" :
        normalizedAdv === "svantaggio" || normalizedAdv === "disadvantage" ? "disadvantage" : "none";
    const regex = /^\s*(\d*)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i;
    const match = expression.match(regex);
    if (!match) {
        throw new Error(`Dice expression invalid: "${expression}". Use format like "1d20", "2d6+3", "d100".`);
    }
    const count = match[1] ? parseInt(match[1], 10) : 1;
    const sides = parseInt(match[2], 10);
    const sign = match[3] || "+";
    const modifier = match[4] ? parseInt(match[4], 10) : 0;
    const modVal = sign === "-" ? -modifier : modifier;
    const rollDie = () => Math.floor(Math.random() * sides) + 1;
    let rolls = [];
    let total = 0;
    let explodedRolls = [];
    if (sides === 20 && advantageMode !== "none") {
        const roll1 = rollDie();
        const roll2 = rollDie();
        rolls = [roll1, roll2];
        const kept = advantageMode === "advantage" ? Math.max(roll1, roll2) : Math.min(roll1, roll2);
        total = kept + modVal;
    }
    else {
        for (let i = 0; i < count; i++) {
            let r = rollDie();
            rolls.push(r);
            // Exploding dice logic (typical for Cyberpunk or Shadowrun)
            if (explode && r === sides) {
                let extraLimit = 0;
                let lastRoll = r;
                while (lastRoll === sides && extraLimit < 5) {
                    const extra = rollDie();
                    explodedRolls.push(extra);
                    r += extra;
                    lastRoll = extra;
                    extraLimit++;
                }
            }
        }
        total = rolls.reduce((sum, val) => sum + val, 0) + modVal + explodedRolls.reduce((sum, val) => sum + val, 0);
    }
    const rollsText = rolls.join(", ") + (explodedRolls.length > 0 ? ` [Esplosioni: ${explodedRolls.join(", ")}]` : "");
    const fullExp = `${expression}${advantageMode !== "none" ? ` (${advantageMode === "advantage" ? "vantaggio" : "svantaggio"})` : ""}${explode ? " (exploding)" : ""}`;
    return {
        total,
        rolls,
        rollsText,
        expression: fullExp,
        modifier: modVal,
        advantage: advantageMode,
        explodedRolls: explodedRolls.length > 0 ? explodedRolls : undefined
    };
}
function setNestedValue(obj, path, value) {
    const parts = path.split(".");
    if (parts.some((part) => ["__proto__", "prototype", "constructor"].includes(part))) {
        throw new Error("Invalid state path.");
    }
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!(part in current) || typeof current[part] !== "object" || current[part] === null) {
            current[part] = {};
        }
        current = current[part];
    }
    current[parts[parts.length - 1]] = value;
}
function characterKey(name) {
    return String(name || "").toLowerCase().trim().replace(/\s+/g, "_");
}
function normalizeCharacter(name, giocatore, sheet = {}, tipo = "giocatore") {
    const normalized = { ...sheet };
    normalized.nome = normalized.nome || name;
    normalized.giocatore = normalized.giocatore || giocatore;
    normalized.tipo = normalized.tipo || tipo;
    normalized.aspetto = normalized.aspetto || normalized.descrizione_fisica || normalized.appearance || normalized.descrizione || "";
    normalized.ritratto = normalized.ritratto || normalized.portrait || normalized.portrait_url || normalized.avatar || "";
    normalized.ruolo = normalized.ruolo || normalized.role || normalized.archetipo || "";
    normalized.classe = normalized.classe || normalized.class || "";
    normalized.razza = normalized.razza || normalized.specie || normalized.race || "";
    normalized.background = normalized.background || normalized.bg || "";
    normalized.ca = normalized.ca ?? normalized.ac ?? normalized.classe_armatura;
    normalized.velocita = normalized.velocita ?? normalized.speed;
    normalized.bonus_competenza = normalized.bonus_competenza ?? normalized.proficiency_bonus;
    normalized.hp = normalized.hp || normalized.pf || normalized.punti_ferita;
    normalized.stats = normalized.stats || normalized.caratteristiche || normalized.abilities;
    if (normalized.stats) {
        const s = normalized.stats;
        normalized.stats = {
            forza: s.forza ?? s.str ?? s.strength,
            destrezza: s.destrezza ?? s.des ?? s.dex ?? s.dexterity,
            costituzione: s.costituzione ?? s.cos ?? s.con ?? s.constitution,
            intelligenza: s.intelligenza ?? s.int ?? s.intelligence,
            saggezza: s.saggezza ?? s.sag ?? s.wis ?? s.wisdom,
            carisma: s.carisma ?? s.car ?? s.cha ?? s.charisma
        };
        for (const key of Object.keys(normalized.stats)) {
            if (normalized.stats[key] === undefined) delete normalized.stats[key];
        }
    }
    if (normalized.hp) {
        const max = Number(normalized.hp.max ?? normalized.hp.massimi ?? normalized.hp.correnti ?? 10);
        const correnti = Number(normalized.hp.correnti ?? max);
        normalized.hp = { max, correnti: Math.max(0, Math.min(max, correnti)) };
    }
    normalized.relazioni = normalizeRelations(normalized.relazioni || normalized.relations || normalized.legami_strutturati);
    return normalized;
}
function normalizeGameState(state) {
    if (!state || typeof state !== "object") return state;
    const normalizedCharacters = {};
    for (const [key, value] of Object.entries(state.personaggi || {})) {
        if (!value || typeof value !== "object") continue;
        const name = value.nome || key;
        normalizedCharacters[characterKey(name)] = normalizeCharacter(name, value.giocatore, value, value.tipo || "giocatore");
    }
    state.personaggi = normalizedCharacters;
    state.mondo = state.mondo || {};
    state.mondo.npcs_incontrati = Array.isArray(state.mondo.npcs_incontrati) ? state.mondo.npcs_incontrati : [];
    return state;
}
function summarizeActiveState(state, runId) {
    const title = state.titolo || state.campagna || runId;
    const place = state.luogo || state.location || state.mondo?.luogo_corrente || state.mondo?.luogo || "non specificato";
    const scene = state.scena || state.scene || state.mondo?.scena_corrente || "";
    const characters = Object.values(state.personaggi || {}).slice(0, 3).map((c) => {
        const hp = c.hp ? `HP ${c.hp.correnti}/${c.hp.max}` : "";
        const pool = c.pool ? `Pool ${c.pool.correnti ?? c.pool.current ?? c.pool}/${c.pool.max ?? c.pool.totale ?? "?"}` : "";
        const conditions = c.condizioni || c.conditions || [];
        const condText = Array.isArray(conditions) ? conditions.join(", ") : String(conditions || "");
        const keys = c.chiavi || c.keys || [];
        const keyText = Array.isArray(keys) ? keys.join(", ") : "";
        return `${c.nome || "PG"}: ${[pool, hp].filter(Boolean).join(" | ") || "scheda attiva"} | Condizioni: ${condText || "nessuna"}${keyText ? ` | Chiavi: ${keyText}` : ""}`;
    });
    const recent = state.scene_recenti || state.scene_recenti_breve || state.ultimi_eventi || state.log_recenti || [];
    const recentText = Array.isArray(recent) ? recent.slice(-3).join("; ") : String(recent || "");
    return [
        `Campagna: ${title} | Turno: ${state.turno || 0} | Sistema: ${state.sistema || state.system || "dnd5e"}`,
        `Luogo: ${place}${scene ? ` | Scena: ${scene}` : ""}`,
        ...characters,
        `Scene recenti: ${recentText || state.ultimo_turno || "nessuna sintesi recente"}`
    ].slice(0, 6).join("\n");
}
function wantsWikiContext(text) {
    const q = String(text || "").toLowerCase();
    return /\b(regol[aei]|manuale|incantesim|danno|tabell|lore|storia|passato|npc|luogo|mappa|ricord|wiki|cerca|chi era|dove|combattimento|iniziativa|arma|tagli[ae]|taglie|stiva|seduzione|dialogo)\b/.test(q);
}
// Function to initialize wiki workspace under user specified data folder dynamically
function initWikiWorkspace(wikiDataDir, defaultCfgPath) {
    if (!existsSync(wikiDataDir)) {
        mkdirSync(wikiDataDir, { recursive: true });
    }
    const configPath = join(wikiDataDir, "wiki.config.json");
    if (!existsSync(configPath)) {
        if (existsSync(defaultCfgPath)) {
            const defaultCfg = JSON.parse(readFileSync(defaultCfgPath, "utf-8"));
            defaultCfg.workspace = wikiDataDir.replace(/\\/g, "/");
            writeFileSync(configPath, JSON.stringify(defaultCfg, null, 2), "utf-8");
        }
    }
    else {
        try {
            const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
            if (cfg.workspace !== wikiDataDir.replace(/\\/g, "/")) {
                cfg.workspace = wikiDataDir.replace(/\\/g, "/");
                writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
            }
        }
        catch (e) {
            console.error("[master-dnd-plugin] Error parsing wiki.config.json:", e);
        }
    }
    // Create necessary runtime folders for wiki execution
    const folders = [
        join(wikiDataDir, "wiki"),
        join(wikiDataDir, "wiki-works"),
        join(wikiDataDir, "wiki-works", "regole"),
        join(wikiDataDir, "wiki-works", "avventure"),
        join(wikiDataDir, "memory")
    ];
    for (const f of folders) {
        if (!existsSync(f)) {
            mkdirSync(f, { recursive: true });
        }
    }
    // Copy skills instructions if missing (so agent can read them from chat if requested)
    const destSkills = join(wikiDataDir, "skills");
    if (!existsSync(destSkills)) {
        mkdirSync(destSkills, { recursive: true });
    }
    const srcSkills = join(dirname(defaultCfgPath), "skills");
    if (existsSync(srcSkills)) {
        for (const file of ["wiki-core.md", "wiki-setup.md", "rpg-gm.md"]) {
            const srcFile = join(srcSkills, file);
            const destFile = join(destSkills, file);
            if (existsSync(srcFile) && !existsSync(destFile)) {
                try {
                    writeFileSync(destFile, readFileSync(srcFile));
                }
                catch { }
            }
        }
    }
    // Default empty session log
    const sessionFile = join(wikiDataDir, "wiki-session.md");
    if (!existsSync(sessionFile)) {
        writeFileSync(sessionFile, "status: ready\nTipo: inizializzazione\nPagine totali: 0\n", "utf-8");
    }
}
export default definePluginEntry({
    id: "master-dnd-plugin",
    name: "D&D Game Master Plugin",
    description: "D&D 5e Game Master plugin with character sheets, persistent JSON states, dice rolling, and integrated Wiki RAG memory.",
    contracts: {
        tools: [
            "rpg_roll",
            "rpg_start_run",
            "rpg_save_state",
            "rpg_load_state",
            "rpg_get_sheet",
            "rpg_update_state",
            "rpg_log_turn",
            "rpg_install_dependencies",
            "rpg_scan_manuals",
            "rpg_list_runs",
            "rpg_create_character",
            "rpg_combat_start",
            "rpg_combat_damage",
            "rpg_combat_next_turn",
            "rpg_combat_end",
            "rpg_restore_backup",
            "rpg_narrate",
            "rpg_wiki_process_raw",
            "rpg_check_wiki",
            "rpg_set_combat_position"
        ]
    },
    register(api) {
        const cfg = (api.pluginConfig ?? {});
        // Default: <plugin-root>/../state  (ovvero la cartella state/ nella root del progetto)
        const DEFAULT_STATE_DIR = join(pluginDir, "..", "state");
        const stateDir = cfg.stateDirectory ?? DEFAULT_STATE_DIR;
        const wikiEnabled = cfg.wikiEnabled !== false;
        const python = cfg.pythonExecutable ?? "python";
        const k = String(cfg.k ?? 3);
        const maxChars = String(cfg.maxChars ?? 600);
        const minRelevance = Number(cfg.minRelevance ?? 0.3);
        const serverPort = cfg.serverPort ?? 7331;
        const dashboardPort = cfg.dashboardPort ?? 47332;
        const debug = cfg.debug === true;
        // Resolve wiki database directory: defaults to <stateDirectory>/wiki-data
        const wikiDataDir = cfg.wikiDataDirectory ? cfg.wikiDataDirectory : join(stateDir, "wiki-data");
        const debugLog = join(wikiDataDir, ".wiki-plugin-debug.log");
        const ensureStateDir = () => {
            if (!existsSync(stateDir)) {
                mkdirSync(stateDir, { recursive: true });
            }
        };
        const getActiveRunId = (sessionKey) => {
            ensureStateDir();
            const key = sessionKey ? sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_") : "default";
            const activeRunFile = join(stateDir, `active_run_${key}.json`);
            if (existsSync(activeRunFile)) {
                try {
                    const content = JSON.parse(readFileSync(activeRunFile, "utf-8"));
                    return content.active_run_id || null;
                }
                catch { }
            }
            const legacyFile = join(stateDir, "active_run.json");
            if (existsSync(legacyFile)) {
                try {
                    const content = JSON.parse(readFileSync(legacyFile, "utf-8"));
                    return content.active_run_id || null;
                }
                catch { }
            }
            return null;
        };
        const setActiveRunId = (runId, sessionKey) => {
            ensureStateDir();
            const key = sessionKey ? sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_") : "default";
            const activeRunFile = join(stateDir, `active_run_${key}.json`);
            writeFileSync(activeRunFile, JSON.stringify({ active_run_id: runId }, null, 2), "utf-8");
            // Update legacy file for backward compatibility
            const legacyFile = join(stateDir, "active_run.json");
            writeFileSync(legacyFile, JSON.stringify({ active_run_id: runId }, null, 2), "utf-8");
        };
        const validateRunId = (runId) => {
            if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(runId)) {
                throw new Error("Invalid run ID.");
            }
            return runId;
        };
        const runStateFile = (runId) => join(stateDir, `${validateRunId(runId)}.json`);
        const runAssetsDir = (runId) => join(wikiDataDir, "wiki-works", "avventure", validateRunId(runId), "assets");
        const ASSET_CT = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
        const loadState = (runId) => {
            ensureStateDir();
            const file = runStateFile(runId);
            if (!existsSync(file)) {
                throw new Error(`Session state file not found for run ID: ${runId}`);
            }
            return normalizeGameState(JSON.parse(readFileSync(file, "utf-8")));
        };
        const saveState = (runId, state, sessionKey) => {
            ensureStateDir();
            runId = validateRunId(runId);
            const file = runStateFile(runId);
            try {
                // Create backup folder for this run
                const backupDir = join(stateDir, "backups", runId);
                if (!existsSync(backupDir)) {
                    mkdirSync(backupDir, { recursive: true });
                }
                // If current state file exists and is valid JSON, copy it to backup
                if (existsSync(file)) {
                    try {
                        const rawContent = readFileSync(file, "utf-8");
                        const oldState = JSON.parse(rawContent);
                        const oldTurn = oldState.turno || 1;
                        const padTurn = String(oldTurn).padStart(4, "0");
                        // 1. Save turn backup (e.g., runId_turno_0001.json)
                        const turnBackupFile = join(backupDir, `${runId}_turno_${padTurn}.json`);
                        writeFileSync(turnBackupFile, rawContent, "utf-8");
                        // 2. Save latest backup (runId_latest.json.bak)
                        const latestBackupFile = join(backupDir, `${runId}_latest.json.bak`);
                        writeFileSync(latestBackupFile, rawContent, "utf-8");
                        // 3. Clean up older backups: keep only last 20
                        const backupFiles = readdirSync(backupDir)
                            .filter(f => f.endsWith(".json") && f.includes("_turno_"))
                            .sort();
                        if (backupFiles.length > 20) {
                            const toDelete = backupFiles.slice(0, backupFiles.length - 20);
                            for (const f of toDelete) {
                                try {
                                    const delPath = join(backupDir, f);
                                    rmSync(delPath, { force: true });
                                }
                                catch { }
                            }
                        }
                    }
                    catch (e) {
                        console.error(`[master-dnd-plugin] Error creating backup for run ${runId}:`, e);
                    }
                }
            }
            catch (err) {
                console.error(`[master-dnd-plugin] Backup folder initialization error:`, err);
            }
            state = normalizeGameState(state);
            // Write the new state file atomically (tmp + rename) to avoid corrupting the save on a mid-write crash
            const tmpFile = `${file}.tmp`;
            writeFileSync(tmpFile, JSON.stringify(state, null, 2), "utf-8");
            renameSync(tmpFile, file);
            setActiveRunId(runId, sessionKey);
        };
        // Python Wiki Paths mapping
        const wikiScriptDir = join(wikiBackendDir, "scripts");
        const wikiPy = join(wikiScriptDir, "wiki.py");
        const wikiContextScript = join(wikiScriptDir, "wiki_context.py");
        const checkSetupScript = join(wikiScriptDir, "wiki_check_setup.py");
        const defaultCfgPath = join(wikiBackendDir, "wiki.config.json");
        const sessionsBriefed = new Set();
        const sessionsWelcomed = new Set();
        const sessionsRulesShown = new Set(); // regole procedurali one-shot per sessione
        const lastInjectedState = new Map(); // sessionKey -> ultimo JSON di stato iniettato (per delta)
        const sessionPromptCounts = new Map();
        // INITIALIZATION OF WIKI ENVIRONMENT
        if (wikiEnabled) {
            try {
                initWikiWorkspace(wikiDataDir, defaultCfgPath);
            }
            catch (err) {
                console.error("[master-dnd-plugin] Error initializing wiki workspace folders:", err);
            }
            // Startup: auto-check and auto-install Python dependencies if missing
            void (async () => {
                const requiredPkgs = "lancedb, sentence_transformers, fastapi, uvicorn, watchfiles, jose";
                try {
                    await execFileAsync(python, ["-c", `import ${requiredPkgs}`], { timeout: 10_000 });
                }
                catch {
                    console.log("[master-dnd-plugin] Some Python dependencies missing — auto-installing from requirements.txt...");
                    const reqPath = join(wikiBackendDir, "requirements.txt");
                    if (existsSync(reqPath)) {
                        try {
                            await execFileAsync(python, ["-m", "pip", "install", "-r", reqPath], { timeout: 300_000 });
                            console.log("[master-dnd-plugin] Python dependencies installed successfully.");
                        }
                        catch (installErr) {
                            console.error("[master-dnd-plugin] Auto-install failed:", installErr.message,
                                `\nManual fix: ${python} -m pip install -r ${reqPath}`);
                            if (debug) {
                                try {
                                    writeFileSync(debugLog, `[${new Date().toISOString()}] AUTO-INSTALL FAIL\n${installErr.message}\n`, "utf-8");
                                }
                                catch { }
                            }
                        }
                    }
                    else {
                        console.error(`[master-dnd-plugin] requirements.txt not found at: ${reqPath}`);
                    }
                }
            })();
            // Startup: auto-initialize LanceDB if missing
            void (async () => {
                const lancedbPath = join(wikiDataDir, "memory", "lancedb");
                if (!existsSync(lancedbPath) && existsSync(wikiPy)) {
                    console.log("[master-dnd-plugin] LanceDB not found — running wiki.py rebuild...");
                    try {
                        await execFileAsync(python, [wikiPy, "rebuild", "--workspace", wikiDataDir], { timeout: 120_000 });
                        console.log("[master-dnd-plugin] LanceDB initialized successfully.");
                    }
                    catch (rebuildErr) {
                        console.error("[master-dnd-plugin] LanceDB auto-rebuild failed:", rebuildErr.message);
                        if (debug) {
                            try {
                                appendFileSync(debugLog, `[${new Date().toISOString()}] LANCEDB REBUILD FAIL\n${rebuildErr.message}\n`, "utf-8");
                            }
                            catch { }
                        }
                    }
                }
            })();
            // Startup: spawn local python wiki server in background
            void (async () => {
                try {
                    await fetch(`http://localhost:${serverPort}/`, { signal: AbortSignal.timeout(1_500) });
                }
                catch {
                    if (existsSync(wikiPy)) {
                        const child = spawn(python, [wikiPy, "serve", "--workspace", wikiDataDir, "--port", String(serverPort)], { stdio: "ignore" });
                        if (debug) {
                            try {
                                appendFileSync(debugLog, `[${new Date().toISOString()}] wiki server spawned (PID ${child.pid})\n`, "utf-8");
                            }
                            catch { }
                        }
                    }
                }
            })();
        }
        // Dashboard HTTP server — serves dashboard.html from disk + game state API
        const _DASH_HTML_PLACEHOLDER = `<!DOCTYPE html>
<html lang="it"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>⚔ D&D Master Console</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700;900&family=Share+Tech+Mono&family=Crimson+Pro:ital,wght@0,300;0,400;1,300&display=swap" rel="stylesheet">
<style>
:root{--obsidian:#09090f;--stone:#12121f;--slate:#1a1a2e;--gold:#c9a227;--gold-dim:#7a5f10;--blood:#8b2020;--blood-bright:#d43030;--arcane:#1a4a6b;--arcane-bright:#3a8abf;--bone:#e8dcc8;--ash:#6b6b7a;--hp-safe:#2d8a4e;--hp-warn:#b8741a;--hp-crit:#c02020;--border:rgba(201,162,39,.2);--border-s:rgba(201,162,39,.5)}
*{box-sizing:border-box;margin:0;padding:0}
body{background-color:var(--obsidian);background-image:radial-gradient(ellipse at 20% 50%,rgba(26,74,107,.08) 0%,transparent 60%),radial-gradient(ellipse at 80% 20%,rgba(139,32,32,.06) 0%,transparent 50%);color:var(--bone);font-family:'Crimson Pro',Georgia,serif;font-size:15px;min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;z-index:9999;pointer-events:none;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.03) 2px,rgba(0,0,0,.03) 4px)}
h1{font-family:'Cinzel',serif;font-weight:900;color:var(--gold);letter-spacing:3px}
h2{font-family:'Cinzel',serif;font-weight:700;font-size:.65rem;letter-spacing:4px;text-transform:uppercase;color:var(--gold-dim)}
.mono{font-family:'Share Tech Mono',monospace}
.app{display:grid;grid-template-rows:auto auto 1fr;min-height:100vh}
.header{display:flex;align-items:center;justify-content:space-between;padding:10px 18px;border-bottom:1px solid var(--border);background:linear-gradient(180deg,rgba(201,162,39,.05) 0%,transparent 100%)}
.header h1{font-size:1rem;text-shadow:0 0 20px rgba(201,162,39,.4)}
.session-info{font-family:'Share Tech Mono',monospace;font-size:.68rem;color:var(--ash);display:flex;gap:14px;align-items:center}
.dot{width:6px;height:6px;border-radius:50%;background:var(--blood-bright);display:inline-block;animation:pulse 2s infinite}
.dot.ok{background:var(--hp-safe)}.dot.err{background:var(--blood-bright)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.party-section{border-bottom:1px solid var(--border);background:var(--stone)}
.party-label{padding:4px 18px 3px;border-bottom:1px solid var(--border)}
.party-strip{display:flex;gap:1px;background:var(--border);overflow-x:auto}
.char-card{flex:1;min-width:160px;background:var(--stone);padding:10px 12px;position:relative;overflow:hidden;transition:background .2s}
.char-card::after{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--gold),transparent);opacity:0;transition:opacity .3s}
.char-card:hover::after{opacity:1}
.char-head{display:flex;align-items:baseline;gap:8px;margin-bottom:5px}
.char-name{font-family:'Cinzel',serif;font-weight:600;font-size:.8rem;color:var(--bone);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.char-tag{font-size:.62rem;color:var(--ash);white-space:nowrap}
.ca-badge{margin-left:auto;font-family:'Cinzel',serif;font-size:.65rem;font-weight:700;color:var(--arcane-bright);border:1px solid var(--arcane);padding:1px 5px;border-radius:3px}
.hp-track{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.hp-bar{flex:1;height:5px;background:rgba(255,255,255,.07);border-radius:2px;overflow:hidden}
.hp-fill{height:100%;border-radius:2px;background:var(--hp-safe);transition:width .5s,background .5s;position:relative}
.hp-fill::after{content:'';position:absolute;right:0;top:0;bottom:0;width:3px;background:rgba(255,255,255,.4);border-radius:0 2px 2px 0}
.hp-fill.warn{background:var(--hp-warn)}.hp-fill.crit{background:var(--hp-crit);animation:critPulse 1s infinite}
@keyframes critPulse{0%,100%{box-shadow:0 0 6px var(--hp-crit)}50%{box-shadow:0 0 2px var(--hp-crit)}}
.hp-text{font-family:'Share Tech Mono',monospace;font-size:.62rem;color:var(--ash);white-space:nowrap}
.char-stats{display:flex;gap:8px;margin-top:3px}
.stat-chip{display:flex;flex-direction:column;align-items:center}
.stat-val{font-family:'Cinzel',serif;font-size:.72rem;font-weight:700;color:var(--gold);line-height:1}
.stat-key{font-size:.48rem;color:var(--ash);text-transform:uppercase;letter-spacing:1px}
.main-content{display:grid;grid-template-columns:270px 1fr;gap:1px;background:var(--border);overflow:hidden;flex:1}
.sidebar{background:var(--stone);padding:14px;overflow-y:auto}
.section-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:7px;border-bottom:1px solid var(--border)}
.round-chip{font-family:'Cinzel',serif;font-size:.62rem;font-weight:700;color:var(--obsidian);background:var(--gold);padding:2px 7px;border-radius:2px;letter-spacing:1px}
.init-list{display:flex;flex-direction:column;gap:5px}
.init-row{display:grid;grid-template-columns:14px 24px 1fr auto;align-items:center;gap:7px;padding:8px 9px;background:var(--slate);border:1px solid transparent;border-radius:4px;transition:all .2s;position:relative;overflow:hidden}
.init-row::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:transparent;transition:background .2s}
.init-row.active{border-color:var(--border-s);background:rgba(201,162,39,.07);box-shadow:0 0 14px rgba(201,162,39,.1)}
.init-row.active::before{background:var(--gold)}
.init-row.dead{opacity:.4}
.init-arrow{font-size:.58rem;color:var(--gold)}
.init-emoji{font-size:1rem;text-align:center;line-height:1}
.init-info{min-width:0}
.init-name{font-family:'Cinzel',serif;font-size:.72rem;font-weight:600;color:var(--bone);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.init-sub{display:flex;align-items:center;gap:5px;margin-top:2px}
.tbadge{font-size:.48rem;padding:1px 4px;border-radius:2px;text-transform:uppercase;letter-spacing:1px;font-family:'Share Tech Mono',monospace}
.tbadge.giocatore{background:rgba(58,138,191,.2);color:var(--arcane-bright);border:1px solid rgba(58,138,191,.3)}
.tbadge.mostro{background:rgba(192,32,32,.2);color:#e06060;border:1px solid rgba(192,32,32,.3)}
.tbadge.compagno{background:rgba(45,138,78,.2);color:#60c080;border:1px solid rgba(45,138,78,.3)}
.init-hp-r{display:flex;flex-direction:column;align-items:flex-end;gap:2px;min-width:52px}
.init-hp-val{font-family:'Share Tech Mono',monospace;font-size:.6rem;color:var(--ash)}
.mini-bar{width:50px;height:4px;background:rgba(255,255,255,.07);border-radius:2px;overflow:hidden}
.mini-fill{height:100%;border-radius:2px;background:var(--hp-safe);transition:width .4s,background .4s}
.grid-area{background:var(--stone);padding:14px;display:flex;flex-direction:column;overflow:auto}
.combat-grid-wrap{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-top:8px}
.combat-grid{display:grid;border:1px solid var(--border-s);border-radius:4px;overflow:hidden;box-shadow:0 0 30px rgba(201,162,39,.05),inset 0 0 30px rgba(0,0,0,.3)}
.cell{width:52px;height:52px;display:flex;align-items:center;justify-content:center;border-right:1px solid rgba(201,162,39,.07);border-bottom:1px solid rgba(201,162,39,.07);font-size:1.45rem;position:relative;cursor:default;transition:background .15s;background:var(--obsidian)}
.cell:hover{background:rgba(201,162,39,.04)}
.cell.tok{background:rgba(201,162,39,.03)}
.cell.act{background:rgba(201,162,39,.1);box-shadow:inset 0 0 12px rgba(201,162,39,.15)}
.cell.act::after{content:'';position:absolute;inset:2px;border:1px solid rgba(201,162,39,.4);border-radius:3px;pointer-events:none;animation:glow 1.5s infinite}
@keyframes glow{0%,100%{border-color:rgba(201,162,39,.4)}50%{border-color:rgba(201,162,39,.85)}}
.coord{position:absolute;bottom:1px;right:2px;font-size:.37rem;color:rgba(201,162,39,.18);font-family:'Share Tech Mono',monospace;line-height:1}
.legend{display:flex;flex-direction:column;gap:5px;padding:10px;background:var(--slate);border:1px solid var(--border);border-radius:4px;min-width:130px}
.leg-title{font-family:'Cinzel',serif;font-size:.58rem;letter-spacing:3px;color:var(--gold-dim);text-transform:uppercase;margin-bottom:3px}
.leg-row{display:flex;align-items:center;gap:7px;font-size:.7rem;color:var(--ash)}
.leg-emoji{font-size:.95rem;width:18px;text-align:center}
.leg-hp{flex:1;height:3px;background:rgba(255,255,255,.07);border-radius:2px;overflow:hidden}
.leg-fill{height:100%;border-radius:2px}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:36px;color:var(--ash);gap:6px;font-style:italic}
.empty-r{font-size:2rem;opacity:.15;margin-bottom:6px}
@media(max-width:760px){.main-content{grid-template-columns:1fr;grid-template-rows:auto 1fr}.sidebar{border-bottom:1px solid var(--border)}}
</style></head>
<body>
<div class="app">
<header class="header">
  <div style="display:flex;align-items:baseline;gap:10px">
    <h1>⚔ MASTER CONSOLE</h1>
    <span id="cname" style="font-family:'Crimson Pro',serif;font-style:italic;color:var(--ash);font-size:.88rem"></span>
  </div>
  <div class="session-info">
    <span class="mono" id="tinfo">—</span>
    <span><span class="dot" id="sdot"></span> <span id="slabel">Connessione...</span></span>
  </div>
</header>
<div class="party-section">
  <div class="party-label"><h2>Personaggi</h2></div>
  <div id="party" class="party-strip"></div>
</div>
<div class="main-content">
  <div class="sidebar">
    <div class="section-header">
      <h2>Iniziativa</h2>
      <span class="round-chip" id="rchip" style="display:none">RND 1</span>
    </div>
    <div class="init-list" id="ilist"><div class="empty"><div class="empty-r">⚔</div><span>Nessun combattimento</span></div></div>
  </div>
  <div class="grid-area">
    <div class="section-header">
      <h2>Area di combattimento</h2>
      <span class="mono" id="gdims" style="font-size:.6rem;color:var(--ash)"></span>
    </div>
    <div id="gcontent"><div class="empty" style="min-height:200px"><div class="empty-r">🗺</div><span>Nessun combattimento attivo</span></div></div>
  </div>
</div>
</div>
<script>
const W=8,H=6;
function pct(c,m){return m>0?Math.max(0,Math.min(100,c/m*100)):0}
function hcls(c,m){const p=pct(c,m);return p>50?'':p>25?'warn':'crit'}
function hbg(c,m){const p=pct(c,m);return p>50?'var(--hp-safe)':p>25?'var(--hp-warn)':'var(--hp-crit)'}
function emoji(tipo){return tipo==='giocatore'?'🧙':tipo==='compagno'?'🛡️':'⚔️'}

function renderParty(chars){
  const el=document.getElementById('party');
  if(!chars||!Object.keys(chars).length){el.innerHTML='<div style="padding:10px 18px;color:var(--ash);font-style:italic;font-size:.78rem">Nessun personaggio</div>';return}
  el.innerHTML=Object.entries(chars).map(([k,c])=>{
    const n=c.nome||k,hp=c.hp||{},has=hp.max!=null,p=has?pct(hp.correnti,hp.max):100,cl=has?hcls(hp.correnti,hp.max):'';
    const stats=Object.entries(c.stats||{}).slice(0,6);
    return\`<div class="char-card">
      <div class="char-head"><span class="char-name">\${n}</span><span class="char-tag">\${[c.classe,c.razza?'· '+c.razza:'',c.livello?'Lv.'+c.livello:''].filter(Boolean).join(' ')}</span>\${c.ca!=null?\`<span class="ca-badge mono">CA \${c.ca}</span>\`:''}
      </div>
      \${has?\`<div class="hp-track"><div class="hp-bar"><div class="hp-fill \${cl}" style="width:\${p}%"></div></div><span class="hp-text">\${hp.correnti}/\${hp.max}</span></div>\`:''}
      \${stats.length?\`<div class="char-stats">\${stats.map(([sk,sv])=>\`<div class="stat-chip"><div class="stat-val">\${sv}</div><div class="stat-key">\${sk}</div></div>\`).join('')}</div>\`:''}
    </div>\`;
  }).join('');
}

function renderInit(comb){
  const el=document.getElementById('ilist'),chip=document.getElementById('rchip');
  if(!comb?.attivo||!comb.ordine_iniziativa?.length){chip.style.display='none';el.innerHTML='<div class="empty"><div class="empty-r">⚔</div><span>Nessun combattimento</span></div>';return}
  chip.style.display='';chip.textContent='RND '+comb.round;
  el.innerHTML=comb.ordine_iniziativa.map((c,i)=>{
    const act=i===comb.indice_corrente,hp=c.hp||{},has=hp.max!=null,p=has?pct(hp.correnti,hp.max):100,dead=has&&hp.correnti===0;
    const em=c.emoji||emoji(c.tipo),bg=has?hbg(hp.correnti,hp.max):'var(--hp-safe)';
    return\`<div class="init-row \${act?'active':''} \${dead?'dead':''}">
      <span class="init-arrow">\${act?'▶':''}</span>
      <span class="init-emoji">\${dead?'💀':em}</span>
      <div class="init-info">
        <div class="init-name">\${c.nome}</div>
        <div class="init-sub"><span class="tbadge \${c.tipo}">\${c.tipo}</span><span class="mono" style="font-size:.52rem;color:var(--ash)">ini \${c.iniziativa}</span></div>
      </div>
      \${has?\`<div class="init-hp-r"><span class="init-hp-val">\${hp.correnti}/\${hp.max}</span><div class="mini-bar"><div class="mini-fill" style="width:\${p}%;background:\${bg}"></div></div></div>\`:''}
    </div>\`;
  }).join('');
}

function renderGrid(comb){
  const el=document.getElementById('gcontent'),di=document.getElementById('gdims');
  if(!comb?.attivo||!comb.ordine_iniziativa?.length){di.textContent='';el.innerHTML='<div class="empty" style="min-height:200px"><div class="empty-r">🗺</div><span>Nessun combattimento</span></div>';return}
  di.textContent=W+'×'+H+' · 1 casella ≈ 1.5m';
  const map={};
  comb.ordine_iniziativa.forEach((c,i)=>{
    const x=c.x!=null?c.x:i%W,y=c.y!=null?c.y:Math.floor(i/W);
    if(x>=0&&x<W&&y>=0&&y<H){const k=x+','+y;if(!map[k])map[k]=[];map[k].push({...c,_i:i})}
  });
  let g=\`<div class="combat-grid-wrap"><div><div class="combat-grid" style="grid-template-columns:repeat(\${W},52px)">\`;
  for(let r=0;r<H;r++)for(let c=0;c<W;c++){
    const k=c+','+r,toks=map[k]||[],t=toks[0],act=toks.some(t=>t._i===comb.indice_corrente);
    const em=t?(t.emoji||emoji(t.tipo)):'',dead=t&&t.hp&&t.hp.correnti===0;
    g+=\`<div class="cell \${toks.length?'tok':''} \${act?'act':''}" title="\${t?t.nome+(t.hp?' HP '+t.hp.correnti+'/'+t.hp.max:''):c+','+r}">\${t?(dead?'<span style="opacity:.4">💀</span>':em):''}\${toks.length>1?\`<span style="position:absolute;top:2px;right:3px;font-size:.42rem;color:var(--gold);font-family:'Share Tech Mono'">\${toks.length}</span>\`:''}<span class="coord">\${c},\${r}</span></div>\`;
  }
  g+=\`</div></div><div class="legend"><div class="leg-title">Token</div>\`;
  comb.ordine_iniziativa.forEach((c,i)=>{
    const act=i===comb.indice_corrente,hp=c.hp||{},has=hp.max!=null,p=has?pct(hp.correnti,hp.max):100,bg=has?hbg(hp.correnti,hp.max):'var(--hp-safe)';
    g+=\`<div class="leg-row \${act?'active':''}"><span class="leg-emoji">\${c.emoji||emoji(c.tipo)}</span><span style="flex:1;\${act?'color:var(--gold)':''}">\${c.nome}</span>\${has?\`<div class="leg-hp"><div class="leg-fill" style="width:\${p}%;background:\${bg}"></div></div>\`:''}</div>\`;
  });
  g+=\`</div></div>\`;
  el.innerHTML=g;
}

async function refresh(){
  try{
    const r=await fetch('http://localhost:${dashboardPort}/api/state',{signal:AbortSignal.timeout(2500)});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const{state}=await r.json();
    document.getElementById('sdot').className='dot ok';
    document.getElementById('slabel').textContent='Connesso';
    document.getElementById('cname').textContent=state.titolo||'';
    document.getElementById('tinfo').textContent='Turno '+(state.turno||0)+' · '+(state.sistema||'dnd5e');
    renderParty(state.personaggi||{});renderInit(state.combattimento);renderGrid(state.combattimento);
  }catch(e){
    document.getElementById('sdot').className='dot err';
    document.getElementById('slabel').textContent='Disconnesso — '+e.message;
  }
}
refresh();setInterval(refresh,2500);
<\/script>
</body></html>`;
        // Gateway auth token + port: config del plugin ha priorità (override per sandbox),
        // poi OPENCLAW_HOME, poi ~/.openclaw. Evita i retry ECONNREFUSED su porta sbagliata.
        let gatewayAuthToken = cfg.gatewayAuthToken || "";
        let gatewayListenPort = cfg.gatewayPort || 18789;
        try {
            const openclawHome = process.env.OPENCLAW_HOME;
            const cfgPath = openclawHome
                ? (existsSync(join(openclawHome, "openclaw.json")) ? join(openclawHome, "openclaw.json") : join(openclawHome, ".openclaw", "openclaw.json"))
                : join(homedir(), ".openclaw", "openclaw.json");
            const ocCfg = JSON.parse(readFileSync(cfgPath, "utf-8").replace(/^﻿/, ""));
            if (!cfg.gatewayAuthToken) gatewayAuthToken = ocCfg.gateway?.auth?.token || "";
            if (!cfg.gatewayPort) gatewayListenPort = ocCfg.gateway?.port || 18789;
        }
        catch { }
        const dashboardHtmlPath = join(pluginDir, "dashboard.html");
        const getDashboardHtml = () => {
            try {
                return readFileSync(dashboardHtmlPath, "utf-8")
                    .replace(/__DASH_PORT__/g, String(dashboardPort));
            }
            catch { return "<h1>dashboard.html not found</h1>"; }
        };
        try {
            if (_dashServer) { try { _dashServer.close(); } catch {} _dashServer = null; }
            const dashServer = createHttpServer((req, res) => {
                res.setHeader("Access-Control-Allow-Origin", "*");
                const url = (req.url || "/").split("?")[0];
                if (url === "/api/state") {
                    res.setHeader("Content-Type", "application/json");
                    const runId = (() => {
                        try { return JSON.parse(readFileSync(join(stateDir, "active_run.json"), "utf-8")).active_run_id || null; } catch { return null; }
                    })();
                    if (!runId) { res.end(JSON.stringify({ error: "no active run" })); return; }
                    try { res.end(JSON.stringify({ state: JSON.parse(readFileSync(join(stateDir, `${runId}.json`), "utf-8")) })); }
                    catch (e) { res.end(JSON.stringify({ error: String(e.message) })); }
                }
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
                else if (url === "/api/chat") {
                    res.setHeader("Content-Type", "application/json");
                    try { res.end(readFileSync(join(stateDir, "chat_snapshot.json"), "utf-8")); }
                    catch { res.end(JSON.stringify({ messages: [], ts: 0 })); }
                }
                else if (url === "/api/config") {
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ dashboardPort, gatewayPort: gatewayListenPort, sessionKey: "main" }));
                }
                else {
                    res.setHeader("Content-Type", "text/html; charset=utf-8");
                    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
                    res.end(getDashboardHtml());
                }
            });
            _dashServer = dashServer;
            dashServer.listen(dashboardPort, "127.0.0.1", () => {
                console.log(`[master-dnd-plugin] Dashboard: http://localhost:${dashboardPort}/`);
            });
            dashServer.on("error", (e) => {
                console.warn(`[master-dnd-plugin] Dashboard server error (port ${dashboardPort}):`, e.message);
            });
            // WebSocket proxy: browser → plugin → OpenClaw (handles auth transparently)
            dashServer.on("upgrade", (req, socket, head) => {
                if (!req.url?.startsWith("/ws")) { socket.destroy(); return; }
                const key = req.headers["sec-websocket-key"];
                if (!key) { socket.destroy(); return; }
                // Complete WS handshake with browser
                const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
                socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
                // Connect to OpenClaw as authenticated client
                const gwWs = new NodeWebSocket(`ws://127.0.0.1:${gatewayListenPort}`);
                let gwReady = false;
                const pending = [];
                let buf = Buffer.alloc(0);
                // Parse WS frames from browser (browser always masks outgoing data)
                const parseFrames = () => {
                    while (buf.length >= 2) {
                        const opcode = buf[0] & 0x0f;
                        const masked = (buf[1] & 0x80) !== 0;
                        let plen = buf[1] & 0x7f, off = 2;
                        if (plen === 126) { if (buf.length < 4) return; plen = buf.readUInt16BE(2); off = 4; }
                        else if (plen === 127) { if (buf.length < 10) return; plen = Number(buf.readBigUInt64BE(2)); off = 10; }
                        const mEnd = masked ? off + 4 : off;
                        if (buf.length < mEnd + plen) return;
                        let pay = buf.slice(mEnd, mEnd + plen);
                        if (masked) { const mk = buf.slice(off, off + 4); pay = Buffer.from(pay); for (let i = 0; i < pay.length; i++) pay[i] ^= mk[i % 4]; }
                        buf = buf.slice(mEnd + plen);
                        if (opcode === 0x8) { gwWs.close(); socket.destroy(); return; }
                        if (opcode === 0x1) { const m = pay.toString("utf8"); if (gwReady) gwWs.send(m); else pending.push(m); }
                    }
                };
                // Send unmasked text frame to browser
                const sendFrame = (text) => {
                    if (socket.destroyed) return;
                    const pay = Buffer.from(text, "utf8");
                    let hdr;
                    if (pay.length < 126) { hdr = Buffer.alloc(2); hdr[0] = 0x81; hdr[1] = pay.length; }
                    else if (pay.length < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x81; hdr[1] = 126; hdr.writeUInt16BE(pay.length, 2); }
                    else { hdr = Buffer.alloc(10); hdr[0] = 0x81; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(pay.length), 2); }
                    socket.write(Buffer.concat([hdr, pay]));
                };
                socket.on("data", (chunk) => { buf = Buffer.concat([buf, chunk]); parseFrames(); });
                socket.on("close", () => gwWs.close());
                socket.on("error", () => gwWs.close());
                // Relay OpenClaw → browser, handle auth internally
                gwWs.on("message", (raw) => {
                    const data = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
                    try {
                        const parsed = JSON.parse(data);
                        // Handle challenge: respond with auth, don't forward to browser
                        if (parsed.event === "connect.challenge") {
                            const nonce = parsed.payload?.nonce || "";
                            gwWs.send(JSON.stringify({ type: "req", id: randomUUID(), method: "connect", params: { minProtocol: 4, maxProtocol: 4, auth: { token: gatewayAuthToken }, client: { id: "gateway-client", version: "1.0.0", platform: process.platform, mode: "backend" }, role: "operator", scopes: ["operator.read", "operator.write"], caps: [] } }));
                            return;
                        }
                        // Handle connect response: mark ready, drain queue, notify browser
                        if (!gwReady && parsed.id && parsed.ok !== undefined) {
                            gwReady = true;
                            pending.forEach(m => gwWs.send(m));
                            pending.length = 0;
                            sendFrame(JSON.stringify({ event: "proxy.connected" }));
                            return;
                        }
                    } catch { }
                    // Persist chat history to file so /api/chat can serve it via HTTP
                    try {
                        const p = JSON.parse(data);
                        if (p.ok === true && Array.isArray(p.payload?.messages) && p.payload.messages.length > 0) {
                            writeFileSync(join(stateDir, "chat_snapshot.json"), JSON.stringify({ messages: p.payload.messages, ts: Date.now() }));
                        }
                    } catch { }
                    sendFrame(data);
                });
                gwWs.on("close", () => { if (!socket.destroyed) { socket.write(Buffer.from([0x88, 0x00])); socket.destroy(); } });
                gwWs.on("error", (e) => { console.warn("[master-dnd-plugin] WS proxy error:", e.message); if (!socket.destroyed) socket.destroy(); });
            });
        } catch (e) {
            console.error("[master-dnd-plugin] Failed to start dashboard server:", e.message);
        }
        // Register combined before_prompt_build hook
        api.on("before_prompt_build", async (event, ctx) => {
            const sessionKey = ctx?.sessionKey;
            const currentSessionKey = sessionKey || "global";
            // On the first message of every session (including after each gateway restart),
            // always show the welcome so the user can pick or start any run they want.
            if (!sessionsWelcomed.has(currentSessionKey)) {
                sessionsWelcomed.add(currentSessionKey);
                const welcomeInjection =
                    `\n<rpg-welcome>\n` +
                    `Benvenuto! Sei il Game Master automatico. Ogni volta che la chat si avvia devi obbligatoriamente proporre al giocatore di scegliere cosa fare — anche se esiste già una campagna salvata.\n` +
                    `DEVI seguire questa procedura OBBLIGATORIA prima di qualsiasi narrazione:\n` +
                    `0. Leggi 'skills/wiki-core.md' e 'skills/rpg-gm.md' se disponibili: wiki-core spiega la memoria, rpg-gm spiega come condurre la sessione e usare i tool.\n` +
                    `1. Se il tool 'rpg_list_runs' e' disponibile, usalo per ottenere l'elenco delle campagne salvate; altrimenti presenta le opzioni senza riprovare il tool.\n` +
                    `2. Saluta il giocatore e presentagli le opzioni disponibili:\n` +
                    `   a) Riprendere una campagna esistente — elencala con titolo, sistema, turno attuale e data di inizio.\n` +
                    `   b) Avviare una NUOVA campagna — chiedi titolo, sistema di gioco (es. D&D 5e, Lady Blackbird, Cyberpunk, Fate…) e nome/classe del personaggio.\n` +
                    `3. In base alla scelta del giocatore:\n` +
                    `   - Riprendere → chiama 'rpg_load_state' con il run_id scelto.\n` +
                    `   - Nuova campagna → raccogli i dati necessari, poi chiama 'rpg_start_run'.\n` +
                    `4. WORLDBUILDING OBBLIGATORIO (solo nuova campagna, PRIMA di iniziare a narrare): costruisci e SCRIVI per intero — nei file wiki sotto wiki-works/avventure/<run_id>/ e nel JSON di stato — l'impianto del mondo:\n` +
                    `   - LORE NASCOSTA: trama di fondo, segreti, antagonista e sue motivazioni, colpi di scena pianificati. Questa lore la conosci SOLO tu (Master): non rivelarla al giocatore, usala per guidare gli eventi con coerenza. Salvala in wiki-works/avventure/<run_id>/synthesis/lore-nascosta.md.tmp.\n` +
                    `   - MAPPE E LUOGHI: definisci le ambientazioni principali e le loro relazioni (geografia, distanze, punti d'interesse) sotto wiki-works/avventure/<run_id>/concepts/.\n` +
                    `   - NPC: crea gli NPC chiave con nome, ruolo, obiettivi e ASPETTO FISICO descritto (volto, corporatura, abbigliamento, segni distintivi) sotto entities/, e registrali in 'mondo.npcs_incontrati'.\n` +
                    `   - PROTAGONISTA E PARTY: ogni personaggio giocante e compagno deve avere una descrizione dell'ASPETTO FISICO oltre a statistiche e personalità, salvata nella sua scheda.\n` +
                    `   Mantieni questi elementi COERENTI per tutta la campagna: non contraddire aspetto, nomi, luoghi o fatti già stabiliti.\n` +
                    `REGOLA ASSOLUTA: NON iniziare a narrare alcuna avventura finché non hai chiamato con successo 'rpg_load_state' o 'rpg_start_run' e ricevuto una risposta di successo.\n` +
                    `</rpg-welcome>\n`;
                return { prependContext: welcomeInjection };
            }
            // Session already welcomed — resume normal flow.
            const activeRunId = getActiveRunId(sessionKey);
            if (!activeRunId) {
                return {
                    prependContext:
                        `\n<rpg-reminder>\n` +
                        `Nessuna sessione attiva. Se 'rpg_list_runs' non e' disponibile, chiedi al giocatore se vuole riprendere o avviare una campagna senza entrare in loop.\n` +
                        `</rpg-reminder>\n`
                };
            }
            const ev = event;
            const userText = ev.userMessage ??
                ev.prompt ??
                ev.currentPrompt ??
                ev.input ??
                ev.message ??
                ev.text ??
                "";
            const parts = [];
            const promptCount = (sessionPromptCounts.get(currentSessionKey) || 0) + 1;
            sessionPromptCounts.set(currentSessionKey, promptCount);
            // 1. INJECT LIGHT ACTIVE STATE (UNIVERSAL)
            let activeSystem = "dnd5e";
            let characterWizardInjection = "";
            let combatInjection = "";
            try {
                const state = loadState(activeRunId);
                activeSystem = state.sistema || state.system || "dnd5e";
                const formattedState = summarizeActiveState(state, activeRunId);
                // ① STATO JSON: inietta solo quando cambia dal turno precedente (delta)
                if (lastInjectedState.get(currentSessionKey) !== formattedState) {
                    lastInjectedState.set(currentSessionKey, formattedState);
                    parts.push(`\n<rpg-state>\n` +
                        `Stato attivo essenziale. Usa questo per rispondere ora; pesca wiki/lore/regole solo se serve.\n` +
                        `${formattedState}\n` +
                        `</rpg-state>\n`);
                }
                // ② REGOLE PROCEDURALI: una sola volta per sessione (non a ogni turno)
                if (!sessionsRulesShown.has(currentSessionKey)) {
                    sessionsRulesShown.add(currentSessionKey);
                    parts.push(`\n<rpg-rules>\n` +
                        `- SKILL GM: se non l'hai gia' fatto in questa sessione, leggi 'skills/rpg-gm.md'. Segui quella procedura per ciclo di gioco, manuale attivo, uso tool e ritmo di salvataggio.\n` +
                        `MANDATORY RULES FOR WIKI INGEST IN THIS CAMPAIGN:\n` +
                        `- Qualsiasi nuova pagina wiki specifica di questa campagna (NPC, lore, riassunti, quest) deve essere scritta sotto il percorso isolato:\n` +
                        `  wiki-works/avventure/${activeRunId}/\n` +
                        `  Esempi:\n` +
                        `  - Entità/NPC: wiki-works/avventure/${activeRunId}/entities/nome-npc.md.tmp\n` +
                        `  - Concetti/Luoghi: wiki-works/avventure/${activeRunId}/concepts/nome-luogo.md.tmp\n` +
                        `  - Riassunti di sessione: wiki-works/avventure/${activeRunId}/synthesis/sessione-001.md.tmp\n` +
                        `- NON scrivere mai pagine specifiche della campagna sotto wiki-works/avventure/ o direttamente sotto wiki/.\n` +
                        `- Le regole condivise di questo specifico sistema di gioco (${activeSystem}) vanno scritte sotto il percorso:\n` +
                        `  wiki-works/regole/${activeSystem}/\n` +
                        `  Esempi di regole: wiki-works/regole/${activeSystem}/combattimento.md, wiki-works/regole/${activeSystem}/incantesimi.md\n` +
                        `- MEMORIA VETTORIALE (STORICO DEI TURNI): non chiamare 'rpg_log_turn' dopo ogni risposta. Salva solo ogni 3 scambi narrativi circa, su richiesta del giocatore, a fine sessione o quando accade una svolta reale (combattimento, nuovo luogo/NPC, rivelazione).\n` +
                        `- COERENZA E DESCRIZIONI: mantieni coerenti per tutta la campagna protagonista, party, NPC, mappe/luoghi e la lore nascosta già stabilita (non contraddire nomi, aspetto fisico, fatti). Ogni personaggio e NPC rilevante deve avere una descrizione dell'ASPETTO FISICO oltre a personalità e statistiche.\n` +
                        `- CREAZIONE DI LORE E NPC DA PARTE DEL GIOCATORE: il giocatore può creare NPC e lore in due modi: 1) descrivendoli in chat (tu li registri in 'mondo.npcs_incontrati' e nei riassunti di turno), o 2) inserendo file Markdown sotto 'wiki-works/avventure/${activeRunId}/entities/<nome-npc>.md' (indicizzati e richiamati dal RAG quando citati).\n` +
                        `- COMPAGNI E PARTY MULTIPLAYER: la sessione supporta più personaggi sotto 'personaggi', ciascuno legato al rispettivo giocatore. Un NPC che si unisce come compagno attivo in combattimento (con HP, CA, statistiche) va registrato con 'rpg_create_character' impostando 'giocatore' su '@NPC' o '@Master'. Un compagno solo narrativo va in 'mondo.npcs_incontrati' con stato 'alleato' o 'compagno'.\n` +
                        `- NARRAZIONE VOCALE (TTS): se il giocatore chiede di ascoltare la narrazione o usa parole come 'leggi', 'parla', 'voce', 'narra', usa 'rpg_narrate' (o 'dnd_narrate') passando il testo narrativo.\n` +
                        `</rpg-rules>\n`);
                }
                // Verifica se attivare il PC Creation Wizard
                const numCharacters = Object.keys(state.personaggi || {}).length;
                const userLower = userText.toLowerCase();
                const wantsNewCharacter = /(?:crea|creare).*(?:pg|personaggio|scheda)/i.test(userText) || userLower.includes("/crea_pg") || userLower.includes("crea_pg");
                if (numCharacters === 0 || wantsNewCharacter) {
                    characterWizardInjection =
                        `\n<rpg-character-wizard>\n` +
                            `ATTENZIONE: Il giocatore deve definire/creare il suo personaggio per la campagna attiva (${state.titolo}, Sistema: ${activeSystem}).\n` +
                            `Come Game Master automatico, devi guidarlo in un processo interattivo e divertente di creazione del personaggio (PC Wizard).\n` +
                            `Linee guida per la creazione:\n` +
                            `1. Chiedi le informazioni passo-passo (non fare tutte le domande insieme). Chiedi prima il Nome, poi la Razza/Origine, la Classe/Archetipo, le Statistiche/Attributi (adatte al sistema '${activeSystem}') e infine l'equipaggiamento iniziale.\n` +
                            `2. Se il sistema è D&D 5e (dnd5e), guida la distribuzione delle caratteristiche base (Forza, Destrezza, Costituzione, Intelligenza, Saggezza, Carisma) usando lo standard array (15, 14, 13, 12, 10, 8) o tiri di dado, e calcola i Punti Ferita massimi e la Classe Armatura (CA).\n` +
                            `3. Se si tratta di un altro sistema (es. Lady Blackbird o Fate), segui le sue regole specifiche di creazione (tratti, chiavi, segreti, aspetti, abilità) leggendole dalla wiki se necessario.\n` +
                            `4. Non appena il giocatore ha completato e confermato le sue scelte, DEVI chiamare immediatamente il tool 'rpg_create_character' (o 'dnd_create_character') passando la scheda personaggio formattata in JSON per salvarla in modo persistente nello stato.\n` +
                            `NON iniziare la narrazione dell'avventura finché la scheda del personaggio non è stata completata e salvata con successo.\n` +
                            `</rpg-character-wizard>\n`;
                }
                // Verifica se c'è un combattimento attivo
                if (state.combattimento && state.combattimento.attivo) {
                    const comb = state.combattimento;
                    const orderList = comb.ordine_iniziativa.map((c, idx) => {
                        const marker = idx === comb.indice_corrente ? "--> " : "    ";
                        const hpInfo = c.hp ? ` (HP: ${c.hp.correnti}/${c.hp.max})` : "";
                        return `${marker}${c.nome} [Iniziativa: ${c.iniziativa}, Tipo: ${c.tipo}]${hpInfo}`;
                    }).join("\n");
                    combatInjection =
                        `\n<rpg-combat>\n` +
                            `ATTENZIONE: È attivo un COMBATTIMENTO STRUTTURATO (Round: ${comb.round}).\n` +
                            `Ordine di Iniziativa (il simbolo '-->' indica chi tocca ora):\n` +
                            `${orderList}\n` +
                            `\n` +
                            `Linee guida per il Game Master:\n` +
                            `1. Descrivi le azioni concentrandoti sul turno del combattente attivo contrassegnato da '-->'. Se tocca a un giocatore, attendi la sua dichiarazione d'azione prima di risolverla.\n` +
                            `2. Se tocca a un mostro o a un compagno controllato da te, decidi la sua azione, effettua i tiri necessari usando 'rpg_roll' e descrivi l'esito.\n` +
                            `3. Se un attacco va a segno e causa danni (o se qualcuno si cura), chiama IMMEDIATAMENTE il tool 'rpg_combat_damage' per aggiornare i Punti Ferita.\n` +
                            `4. Non appena il turno corrente è concluso, DEVI chiamare il tool 'rpg_combat_next_turn' per far avanzare l'iniziativa al prossimo combattente.\n` +
                            `5. Se tutti i nemici sono sconfitti o se il combattimento si conclude, chiama immediatamente il tool 'rpg_combat_end' per terminare la modalità strutturata.\n` +
                            `</rpg-combat>\n`;
                }
                if (promptCount % 3 === 0) {
                    parts.push(`\n<rpg-save-rhythm>\n` +
                        `Se negli ultimi 3 scambi e' successo qualcosa da ricordare, chiama 'rpg_log_turn' con una sintesi di 2-4 righe. Se non e' cambiato nulla, non salvare.\n` +
                        `</rpg-save-rhythm>\n`);
                }
            }
            catch (err) {
                console.error(`[master-dnd-plugin] Error loading state for inject:`, err);
            }
            // 2. INJECT WIKI RAG CONTEXT only when useful.
            if (wikiEnabled && userText.trim() && wantsWikiContext(userText)) {
                // A. Session Briefing (First prompt of session only)
                const currentSessionKey = ctx?.sessionKey || "global";
                if (!sessionsBriefed.has(currentSessionKey)) {
                    sessionsBriefed.add(currentSessionKey);
                    if (existsSync(checkSetupScript)) {
                        try {
                            const { stdout } = await execFileAsync(python, [checkSetupScript, "--workspace", wikiDataDir], { encoding: "utf-8", timeout: 15_000 });
                            const briefing = stdout.trim();
                            if (briefing)
                                parts.push(briefing);
                        }
                        catch {
                            // Fail silently
                        }
                    }
                }
                // B. Wiki Context Retrieval
                // serverAnswered = il server FastAPI ha risposto (anche con corpo vuoto = "nessun contesto
                // rilevante", risposta valida). Il fallback CLI deve scattare SOLO se il server è
                // irraggiungibile: altrimenti ogni risposta vuota cold-loaderebbe bge-m3 (>15s) mandando
                // l'hook in timeout a ogni messaggio.
                let serverAnswered = false;
                // Attempt fast HTTP call to FastAPI server
                try {
                    const runIdParam = activeRunId ? `&run_id=${encodeURIComponent(activeRunId)}` : "";
                    const url = `http://127.0.0.1:${serverPort}/api/context?q=${encodeURIComponent(userText)}&k=${k}&max_chars=${maxChars}&min_relevance=${minRelevance}${runIdParam}`;
                    const resp = await fetch(url, { signal: AbortSignal.timeout(3_000) });
                    if (resp.ok) {
                        serverAnswered = true;
                        const text = (await resp.text()).trim();
                        if (text) {
                            parts.push(text);
                        }
                    }
                }
                catch {
                    // Server not responding, fall through to CLI subprocess
                }
                // Subprocess fallback solo se il server è irraggiungibile (non se ha risposto vuoto)
                if (!serverAnswered && existsSync(wikiContextScript)) {
                    try {
                        const result = await execFileAsync(python, [
                            wikiContextScript,
                            "--workspace", wikiDataDir,
                            "--q", userText,
                            "--k", k,
                            "--max-chars", maxChars,
                            "--min-relevance", String(minRelevance),
                            ...(activeRunId ? ["--run-id", activeRunId] : [])
                        ], { encoding: "utf-8", timeout: 15_000 });
                        const context = result.stdout.trim();
                        if (context)
                            parts.push(context);
                    }
                    catch (err) {
                        if (debug) {
                            try {
                                appendFileSync(debugLog, `[${new Date().toISOString()}] wiki_context.py error: ${String(err)}\n`, "utf-8");
                            }
                            catch { }
                        }
                    }
                }
            }
            const output = (parts.join("\n\n").trim() +
                (characterWizardInjection ? `\n\n${characterWizardInjection}` : "") +
                (combatInjection ? `\n\n${combatInjection}` : "")).trim();
            if (output) {
                return { prependContext: output };
            }
            return {};
        }, { priority: 55 });
        // Register Tools with Alias Helper
        if (typeof api.registerTool === "function") {
            const apiT = api;
            const registerWithAlias = (name, factory) => {
                // Register primary tool (rpg_*)
                apiT.registerTool((ctx) => factory(ctx), { name });
                // Register retrocompatible alias (dnd_*)
                if (name.startsWith("rpg_")) {
                    const aliasName = name.replace("rpg_", "dnd_");
                    const aliasFactory = (ctx) => {
                        const def = factory(ctx);
                        def.name = aliasName;
                        return def;
                    };
                    apiT.registerTool(aliasFactory, { name: aliasName });
                }
            };
            // 1. Tool: rpg_roll
            registerWithAlias("rpg_roll", (ctx) => ({
                name: "rpg_roll",
                label: "Roll Dice",
                description: "Effettua un tiro di dadi algebrico (es. 1d20+5, 3d6, 1d100) supportando vantaggio/svantaggio e dadi esplosivi.",
                parameters: {
                    type: "object",
                    properties: {
                        expression: {
                            type: "string",
                            description: "La formula algebrica dei dadi (es: '1d20+5', '3d6', 'd100')."
                        },
                        advantage: {
                            type: "string",
                            enum: ["none", "vantaggio", "svantaggio", "advantage", "disadvantage"],
                            default: "none",
                            description: "D&D 5e: Vantaggio (tira 2d20 prendi il più alto) o svantaggio (prendi il più basso)."
                        },
                        explode: {
                            type: "boolean",
                            default: false,
                            description: "Dadi esplosivi: se esce il valore massimo, tira di nuovo e sommalo (es: Cyberpunk/Shadowrun)."
                        }
                    },
                    required: ["expression"]
                },
                execute: async (_toolCallId, rawParams) => {
                    try {
                        const result = parseAndRoll(rawParams.expression, rawParams.advantage || "none", rawParams.explode === true);
                        const signText = result.modifier >= 0 ? `+${result.modifier}` : `${result.modifier}`;
                        const rollsStr = `[${result.rollsText}]`;
                        const text = `Tiro di dado: ${result.expression} | Dadi: ${rollsStr} (modificatore: ${signText}) | Totale: **${result.total}**`;
                        return {
                            status: "success",
                            rolls: result.rolls,
                            explodedRolls: result.explodedRolls,
                            total: result.total,
                            modifier: result.modifier,
                            advantage: result.advantage,
                            expression: result.expression,
                            text,
                        };
                    }
                    catch (err) {
                        return { status: "error", message: err.message };
                    }
                }
            }));
            // 2. Tool: rpg_start_run
            registerWithAlias("rpg_start_run", (ctx) => ({
                name: "rpg_start_run",
                label: "Start Run",
                description: "Inizia una nuova sessione di gioco GDR con l'IA, definendo il sistema di gioco e caricando la scheda del PG.",
                parameters: {
                    type: "object",
                    properties: {
                        run_id: { type: "string", description: "ID univoco opzionale per la run." },
                        title: { type: "string", description: "Titolo o nome della campagna." },
                        sistema: { type: "string", default: "dnd5e", description: "Sistema di regole di gioco (es: dnd5e, cyberpunk, cthulhu, fate)." },
                        giocatore: { type: "string", description: "Nome o tag del giocatore (es: @Mario)." },
                        // Flexible Character Sheet
                        scheda_personaggio: {
                            type: "object",
                            description: "La scheda personaggio libera (JSON arbitrario adatto per qualsiasi GDR diverso da D&D)."
                        },
                        // Backward compatibility fields for D&D
                        character_name: { type: "string", description: "D&D: Nome del personaggio." },
                        classe: { type: "string", description: "D&D: Classe del personaggio." },
                        razza: { type: "string", description: "D&D: Razza del personaggio." },
                        livello: { type: "integer", default: 1, description: "D&D: Livello del PG." },
                        hp_max: { type: "integer", default: 10, description: "D&D: Punti Ferita massimi." },
                        ca: { type: "integer", default: 10, description: "D&D: Classe Armatura." },
                        stats: { type: "object", description: "D&D: Statistiche (for, des, cos...)." },
                        inventario: { type: "array", items: { type: "string" }, description: "D&D: Oggetti iniziali." }
                    },
                    required: ["title", "giocatore"]
                },
                execute: async (_toolCallId, rawParams) => {
                    try {
                        const runId = rawParams.run_id || `run-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${Math.random().toString(36).substring(2, 6)}`;
                        const sistema = rawParams.sistema || "dnd5e";
                        let personaggi = {};
                        if (rawParams.scheda_personaggio) {
                            const charName = rawParams.character_name || rawParams.scheda_personaggio.nome || rawParams.giocatore;
                            personaggi[characterKey(charName)] = normalizeCharacter(charName, rawParams.giocatore, rawParams.scheda_personaggio);
                        }
                        else if (rawParams.character_name) {
                            // Map old D&D parameters to character sheet
                            const charName = rawParams.character_name;
                            const level = rawParams.livello || 1;
                            const hpMax = rawParams.hp_max || 10;
                            const ca = rawParams.ca || 10;
                            const defaultStats = { for: 10, des: 10, cos: 10, int: 10, sag: 10, car: 10 };
                            const stats = rawParams.stats ? { ...defaultStats, ...rawParams.stats } : defaultStats;
                            const inventory = rawParams.inventario || ["Vestiti comuni", "Razioni (5)"];
                            personaggi = {
                                [characterKey(charName)]: {
                                    nome: charName,
                                    giocatore: rawParams.giocatore,
                                    razza: rawParams.razza || "Sconosciuta",
                                    classe: rawParams.classe || "Sconosciuta",
                                    livello: level,
                                    stats,
                                    hp: { max: hpMax, correnti: hpMax },
                                    ca,
                                    inventario: inventory,
                                    quest_attive: ["Esplorare e sopravvivere"]
                                }
                            };
                        }
                        const newState = {
                            run_id: runId,
                            titolo: rawParams.title,
                            sistema,
                            data_inizio: new Date().toISOString(),
                            turno: 1,
                            personaggi,
                            mondo: {
                                locazione: "Inizio avventura",
                                tempo: "Giorno, Sereno",
                                npcs_incontrati: [],
                                stato_trame: {}
                            },
                            combattimento: {
                                attivo: false,
                                round: 0,
                                ordine_iniziativa: [],
                                indice_corrente: 0
                            }
                        };
                        saveState(runId, newState, ctx?.sessionKey);
                        // Avvia la scansione dei manuali e delle avventure in background all'avvio
                        const watcherScript = join(wikiScriptDir, "wiki_manuals_watcher.py");
                        if (existsSync(watcherScript)) {
                            try {
                                const child = spawn(python, [watcherScript, "--workspace", wikiDataDir], {
                                    stdio: "ignore"
                                });
                                child.unref();
                            }
                            catch { }
                        }
                        return { status: "success", run_id: runId, state: newState };
                    }
                    catch (err) {
                        return { status: "error", message: err.message };
                    }
                }
            }));
            // 3. Tool: rpg_save_state
            registerWithAlias("rpg_save_state", (ctx) => ({
                name: "rpg_save_state",
                label: "Save State",
                description: "Salva manualmente lo stato corrente della run GDR nel file JSON persistente.",
                parameters: {
                    type: "object",
                    properties: {
                        run_id: { type: "string", description: "ID della run da salvare." },
                        state: { type: "object", description: "L'intero oggetto stato aggiornato da salvare." }
                    },
                    required: ["run_id", "state"]
                },
                execute: async (_toolCallId, rawParams) => {
                    try {
                        saveState(rawParams.run_id, rawParams.state, ctx?.sessionKey);
                        return { status: "success", run_id: rawParams.run_id, message: "Stato salvato con successo." };
                    }
                    catch (err) {
                        return { status: "error", message: err.message };
                    }
                }
            }));
            // 4. Tool: rpg_load_state
            registerWithAlias("rpg_load_state", (ctx) => ({
                name: "rpg_load_state",
                label: "Load State",
                description: "Carica lo stato persistente di una sessione di gioco GDR esistente.",
                parameters: {
                    type: "object",
                    properties: {
                        run_id: { type: "string", description: "ID della run da caricare." }
                    },
                    required: ["run_id"]
                },
                execute: async (_toolCallId, rawParams) => {
                    try {
                        const state = loadState(rawParams.run_id);
                        setActiveRunId(rawParams.run_id, ctx?.sessionKey);
                        // Avvia la scansione dei manuali e delle avventure in background al caricamento
                        const watcherScript = join(wikiScriptDir, "wiki_manuals_watcher.py");
                        if (existsSync(watcherScript)) {
                            try {
                                const child = spawn(python, [watcherScript, "--workspace", wikiDataDir], {
                                    stdio: "ignore"
                                });
                                child.unref();
                            }
                            catch { }
                        }
                        return { status: "success", run_id: rawParams.run_id, state };
                    }
                    catch (err) {
                        return { status: "error", message: err.message };
                    }
                }
            }));
            // 5. Tool: rpg_get_sheet
            registerWithAlias("rpg_get_sheet", (ctx) => ({
                name: "rpg_get_sheet",
                label: "Get Sheet",
                description: "Ottiene la scheda del personaggio o dei personaggi attivi nella sessione.",
                parameters: {
                    type: "object",
                    properties: {
                        run_id: { type: "string", description: "ID della run attiva." }
                    },
                    required: ["run_id"]
                },
                execute: async (_toolCallId, rawParams) => {
                    try {
                        const state = loadState(rawParams.run_id);
                        return { status: "success", personaggi: state.personaggi };
                    }
                    catch (err) {
                        return { status: "error", message: err.message };
                    }
                }
            }));
            // 6. Tool: rpg_update_state
            registerWithAlias("rpg_update_state", (ctx) => ({
                name: "rpg_update_state",
                label: "Update State",
                description: "Aggiorna un singolo valore nello stato (es. punti ferita, turno, locazione, inventario) usando la dot notation.",
                parameters: {
                    type: "object",
                    properties: {
                        run_id: { type: "string", description: "ID della run attiva." },
                        path: { type: "string", description: "Il percorso dot-notation della proprietà da aggiornare (es. 'turno', 'personaggi.eldrin.hp.correnti')." },
                        value: { description: "Il nuovo valore da inserire (stringa, numero, array, boolean, ecc)." }
                    },
                    required: ["run_id", "path", "value"]
                },
                execute: async (_toolCallId, rawParams) => {
                    try {
                        const state = loadState(rawParams.run_id);
                        setNestedValue(state, rawParams.path, rawParams.value);
                        saveState(rawParams.run_id, state, ctx?.sessionKey);
                        return { status: "success", run_id: rawParams.run_id, state };
                    }
                    catch (err) {
                        return { status: "error", message: err.message };
                    }
                }
            }));
            // 7. Tool: rpg_log_turn
            registerWithAlias("rpg_log_turn", (ctx) => ({
                name: "rpg_log_turn",
                label: "Log Turn Synthesis",
                description: "Salva una sintesi narrativa del turno corrente nel database vettoriale RAG della campagna e incrementa il contatore del turno.",
                parameters: {
                    type: "object",
                    properties: {
                        synthesis: {
                            type: "string",
                            description: "Sintesi oggettiva e compatta delle azioni, tiri di dado ed esiti di questo turno."
                        }
                    },
                    required: ["synthesis"]
                },
                execute: async (_toolCallId, rawParams) => {
                    if (!wikiEnabled) {
                        return { status: "error", message: "Wiki RAG non abilitata." };
                    }
                    const activeRunId = getActiveRunId(ctx?.sessionKey);
                    if (!activeRunId) {
                        return { status: "error", message: "Nessuna run attiva trovata. Avvia prima una run con rpg_start_run." };
                    }
                    try {
                        const state = loadState(activeRunId);
                        const turno = state.turno || 1;
                        const padTurno = String(turno).padStart(4, "0");
                        const relPath = `wiki-works/avventure/${activeRunId}/synthesis/turno-${padTurno}.md`;
                        const tmpFileAbs = join(wikiDataDir, `${relPath}.tmp`);
                        const parentDir = dirname(tmpFileAbs);
                        if (!existsSync(parentDir)) {
                            mkdirSync(parentDir, { recursive: true });
                        }
                        const fileContent = `# Turno ${turno} — Sintesi\n\n${rawParams.synthesis}\n`;
                        writeFileSync(tmpFileAbs, fileContent, "utf-8");
                        if (!existsSync(wikiPy)) {
                            return { status: "error", message: `Script wiki.py non trovato.` };
                        }
                        const args = [
                            wikiPy,
                            "ingest",
                            "--workspace", wikiDataDir,
                            "--pages", `${relPath}.tmp`,
                            "--log", `Turn ${turno} logged automatically for run ${activeRunId}`
                        ];
                        const { stdout } = await execFileAsync(python, args, { encoding: "utf-8", timeout: 30_000 });
                        state.turno = turno + 1;
                        saveState(activeRunId, state, ctx?.sessionKey);
                        return {
                            status: "success",
                            message: `Turno ${turno} registrato e vettorializzato con successo. Il prossimo turno sarà il turno ${state.turno}.`,
                            relPath,
                            output: stdout.trim()
                        };
                    }
                    catch (err) {
                        return {
                            status: "error",
                            message: `Errore durante la registrazione del turno: ${err.message}`
                        };
                    }
                }
            }));
            // 8. Tool: rpg_wiki_process_raw (alias: dnd_wiki_process_raw)
            registerWithAlias("rpg_wiki_process_raw", (_ctx) => ({
                name: "rpg_wiki_process_raw",
                label: "Wiki Process Raw",
                description: "Sposta e indicizza i file dalla cartella 'raw/' all'indice della Wiki (utile dopo importazione di manuali PDF).",
                parameters: {
                    type: "object",
                    properties: {
                        project: {
                            type: "string",
                            description: "Limita l'indicizzazione a un singolo progetto (es: 'regole', 'avventure')."
                        }
                    }
                },
                execute: async (_toolCallId, params) => {
                    if (!wikiEnabled) {
                        return { status: "error", message: "Wiki RAG non abilitata." };
                    }
                    if (!existsSync(wikiPy)) {
                        return { status: "error", message: "Script wiki.py non trovato." };
                    }
                    const args = ["process-raw", "--workspace", wikiDataDir];
                    if (params?.project) {
                        args.push("--project", params.project);
                    }
                    try {
                        const { stdout } = await execFileAsync(python, [wikiPy, ...args], {
                            encoding: "utf-8",
                            timeout: 120_000,
                        });
                        return JSON.parse(stdout);
                    }
                    catch (err) {
                        return { status: "error", message: String(err.message || err) };
                    }
                }
            }));
            // 9. Tool: rpg_install_dependencies (alias: dnd_install_dependencies)
            registerWithAlias("rpg_install_dependencies", (ctx) => ({
                name: "rpg_install_dependencies",
                label: "Install RPG Wiki Dependencies",
                description: "Esegue l'installazione delle librerie Python (pip) necessarie per il funzionamento della Wiki RAG locale.",
                parameters: {
                    type: "object",
                    properties: {}
                },
                execute: async (_toolCallId) => {
                    try {
                        const reqPath = join(wikiBackendDir, "requirements.txt");
                        if (!existsSync(reqPath)) {
                            return { status: "error", message: `File requirements.txt non trovato.` };
                        }
                        const args = ["-m", "pip", "install", "-r", reqPath];
                        const { stdout, stderr } = await execFileAsync(python, args, { timeout: 300_000 });
                        return {
                            status: "success",
                            message: "Dipendenze Python installate correttamente!",
                            stdout: stdout.trim(),
                            stderr: stderr.trim()
                        };
                    }
                    catch (err) {
                        return {
                            status: "error",
                            message: `Impossibile installare le dipendenze: ${err.message}`,
                            stdout: err.stdout || "",
                            stderr: err.stderr || ""
                        };
                    }
                }
            }));
            // 10. Tool: rpg_scan_manuals (alias: dnd_scan_manuals)
            registerWithAlias("rpg_scan_manuals", (ctx) => ({
                name: "rpg_scan_manuals",
                label: "Scan RPG Manuals",
                description: "Scansiona la cartella 'manuali/' alla ricerca di nuovi PDF, estrae il testo e li vettorializza nel database dividendoli per sistema (in base alle sottocartelle).",
                parameters: {
                    type: "object",
                    properties: {}
                },
                execute: async (_toolCallId) => {
                    if (!wikiEnabled) {
                        return { status: "error", message: "Wiki RAG non abilitata." };
                    }
                    const watcherScript = join(wikiScriptDir, "wiki_manuals_watcher.py");
                    if (!existsSync(watcherScript)) {
                        return { status: "error", message: `Script watcher non trovato in: ${watcherScript}` };
                    }
                    try {
                        const args = [watcherScript, "--workspace", wikiDataDir];
                        const { stdout } = await execFileAsync(python, args, { encoding: "utf-8", timeout: 300_000 });
                        return JSON.parse(stdout);
                    }
                    catch (err) {
                        return {
                            status: "error",
                            message: `Errore durante la scansione e l'ingest dei manuali: ${err.message}`,
                            stdout: err.stdout || ""
                        };
                    }
                }
            }));
            // 11. Tool: rpg_list_runs (alias: dnd_list_runs)
            registerWithAlias("rpg_list_runs", (ctx) => ({
                name: "rpg_list_runs",
                label: "List RPG Runs",
                description: "Elenca tutte le campagne e le sessioni di gioco precedentemente salvate su disco con i loro dettagli.",
                parameters: {
                    type: "object",
                    properties: {}
                },
                execute: async (_toolCallId) => {
                    try {
                        ensureStateDir();
                        const files = readdirSync(stateDir);
                        const runs = [];
                        for (const file of files) {
                            if (file.endsWith(".json") && file !== "active_run.json" && file !== ".registry.json") {
                                try {
                                    const content = JSON.parse(readFileSync(join(stateDir, file), "utf-8"));
                                    if (content.run_id) {
                                        runs.push({
                                            run_id: content.run_id,
                                            titolo: content.titolo || "Senza Titolo",
                                            sistema: content.sistema || content.system || "dnd5e",
                                            data_inizio: content.data_inizio || "Sconosciuta",
                                            turno: content.turno || 1,
                                            personaggi: Object.keys(content.personaggi || {})
                                        });
                                    }
                                }
                                catch {
                                    // Salta file corrotti
                                }
                            }
                        }
                        return { status: "success", runs };
                    }
                    catch (err) {
                        return { status: "error", message: err.message };
                    }
                }
            }));
            // 12. Tool: rpg_create_character (alias: dnd_create_character)
            registerWithAlias("rpg_create_character", (ctx) => ({
                name: "rpg_create_character",
                label: "Create/Edit Character",
                description: "Salva o aggiorna la scheda personaggio nello stato della sessione attiva.",
                parameters: {
                    type: "object",
                    properties: {
                        run_id: { type: "string", description: "L'ID della sessione attiva (opzionale)." },
                        character_name: { type: "string", description: "Il nome del personaggio da creare o modificare." },
                        giocatore: { type: "string", description: "Il nome/tag del giocatore (es: @Mario)." },
                        tipo: { type: "string", enum: ["giocatore", "npc", "compagno"], default: "giocatore", description: "Tipo di personaggio salvato." },
                        scheda_personaggio: {
                            type: "object",
                            description: "La scheda completa in JSON. Oltre alle regole del sistema, includi sempre campi narrativi/visivi: aspetto o descrizione_fisica, ruolo/archetipo, personalità, obiettivo, legami, e opzionalmente ritratto/portrait_url/avatar."
                        }
                    },
                    required: ["character_name", "giocatore", "scheda_personaggio"]
                },
                execute: async (_toolCallId, rawParams) => {
                    try {
                        const runId = rawParams.run_id || getActiveRunId(ctx?.sessionKey);
                        if (!runId) {
                            return { status: "error", message: "Nessuna run attiva trovata per registrare il personaggio." };
                        }
                        const state = loadState(runId);
                        if (!state.personaggi) {
                            state.personaggi = {};
                        }
                        const tipo = rawParams.tipo || (String(rawParams.giocatore || "").startsWith("@NPC") ? "npc" : "giocatore");
                        const charNameKey = characterKey(rawParams.character_name);
                        state.personaggi[charNameKey] = normalizeCharacter(rawParams.character_name, rawParams.giocatore, rawParams.scheda_personaggio, tipo);
                        if (tipo !== "giocatore") {
                            state.mondo = state.mondo || {};
                            state.mondo.npcs_incontrati = Array.isArray(state.mondo.npcs_incontrati) ? state.mondo.npcs_incontrati : [];
                            const idx = state.mondo.npcs_incontrati.findIndex((n) => characterKey(n.nome) === charNameKey);
                            const sheet = state.personaggi[charNameKey] || {};
                            const npc = { nome: rawParams.character_name, stato: tipo, giocatore: rawParams.giocatore };
                            if (sheet.ritratto) npc.ritratto = sheet.ritratto;
                            if (sheet.relazioni && sheet.relazioni.length) npc.relazioni = sheet.relazioni;
                            if (sheet.aspetto) npc.descrizione = npc.descrizione || sheet.aspetto;
                            if (idx === -1) state.mondo.npcs_incontrati.push(npc);
                            else state.mondo.npcs_incontrati[idx] = { ...state.mondo.npcs_incontrati[idx], ...npc };
                        }
                        saveState(runId, state, ctx?.sessionKey);
                        return {
                            status: "success",
                            message: `Personaggio '${rawParams.character_name}' salvato con successo nella run '${runId}'.`,
                            state
                        };
                    }
                    catch (err) {
                        return { status: "error", message: err.message };
                    }
                }
            }));
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
            // 13. Tool: rpg_combat_start (alias: dnd_combat_start)
            registerWithAlias("rpg_combat_start", (ctx) => ({
                name: "rpg_combat_start",
                label: "Start Combat",
                description: "Inizia un combattimento strutturato, ordinando i partecipanti per iniziativa.",
                parameters: {
                    type: "object",
                    properties: {
                        run_id: { type: "string", description: "L'ID della sessione attiva (opzionale)." },
                        combattenti: {
                            type: "array",
                            description: "Lista di partecipanti al combattimento.",
                            items: {
                                type: "object",
                                properties: {
                                    nome: { type: "string", description: "Nome del combattente." },
                                    iniziativa: { type: "integer", description: "Il valore di iniziativa. Se omesso, verrà calcolato con 1d20." },
                                    tipo: { type: "string", enum: ["giocatore", "mostro", "compagno"], description: "Tipo di combattente." },
                                    hp_max: { type: "integer", description: "Punti ferita massimi (obbligatorio per i mostri, per i giocatori viene letto dalla scheda)." }
                                },
                                required: ["nome", "tipo"]
                            }
                        }
                    },
                    required: ["combattenti"]
                },
                execute: async (_toolCallId, rawParams) => {
                    try {
                        const runId = rawParams.run_id || getActiveRunId(ctx?.sessionKey);
                        if (!runId) {
                            return { status: "error", message: "Nessuna run attiva trovata per iniziare il combattimento." };
                        }
                        const state = loadState(runId);
                        const combattentiElaborati = rawParams.combattenti.map((c) => {
                            let initVal = c.iniziativa;
                            if (initVal === undefined || initVal === null) {
                                initVal = Math.floor(Math.random() * 20) + 1;
                            }
                            let hp = undefined;
                            if (c.tipo !== "mostro") {
                                const charKey = characterKey(c.nome);
                                const p = state.personaggi?.[charKey];
                                if (p && p.hp) {
                                    hp = { max: p.hp.max, correnti: p.hp.correnti };
                                }
                                else {
                                    throw new Error(`Combattente '${c.nome}' non trovato tra i personaggi salvati. Usa prima rpg_create_character.`);
                                }
                            }
                            else {
                                const maxHp = c.hp_max || 10;
                                hp = { max: maxHp, correnti: maxHp };
                            }
                            return {
                                nome: c.nome,
                                iniziativa: initVal,
                                tipo: c.tipo,
                                hp
                            };
                        });
                        combattentiElaborati.sort((a, b) => b.iniziativa - a.iniziativa);
                        // Auto-assign grid positions: players/companions bottom row(s), monsters top row(s)
                        const GRID_W = 8;
                        const players = combattentiElaborati.filter(c => c.tipo !== "mostro");
                        const monsters = combattentiElaborati.filter(c => c.tipo === "mostro");
                        players.forEach((c, i) => { if (c.x == null) { c.x = Math.min(i * 2 + 1, GRID_W - 1); c.y = 5; } });
                        monsters.forEach((c, i) => { if (c.x == null) { c.x = Math.min(i * 2 + 1, GRID_W - 1); c.y = 0; } });
                        state.combattimento = {
                            attivo: true,
                            round: 1,
                            ordine_iniziativa: combattentiElaborati,
                            indice_corrente: 0
                        };
                        saveState(runId, state, ctx?.sessionKey);
                        return {
                            status: "success",
                            message: "Combattimento iniziato con successo. Ordine di iniziativa calcolato.",
                            combattimento: state.combattimento,
                            state
                        };
                    }
                    catch (err) {
                        return { status: "error", message: err.message };
                    }
                }
            }));
            // 14. Tool: rpg_combat_next_turn (alias: dnd_combat_next_turn)
            registerWithAlias("rpg_combat_next_turn", (ctx) => ({
                name: "rpg_combat_next_turn",
                label: "Next Turn in Combat",
                description: "Avanza il turno del combattimento al prossimo partecipante dell'iniziativa.",
                parameters: {
                    type: "object",
                    properties: {
                        run_id: { type: "string", description: "L'ID della sessione attiva (opzionale)." }
                    }
                },
                execute: async (_toolCallId, rawParams) => {
                    try {
                        const runId = rawParams.run_id || getActiveRunId(ctx?.sessionKey);
                        if (!runId) {
                            return { status: "error", message: "Nessuna run attiva trovata." };
                        }
                        const state = loadState(runId);
                        if (!state.combattimento || !state.combattimento.attivo) {
                            return { status: "error", message: "Nessun combattimento attivo in questa sessione." };
                        }
                        const comb = state.combattimento;
                        comb.indice_corrente += 1;
                        if (comb.indice_corrente >= comb.ordine_iniziativa.length) {
                            comb.indice_corrente = 0;
                            comb.round += 1;
                        }
                        saveState(runId, state, ctx?.sessionKey);
                        return {
                            status: "success",
                            message: `Turno avanzato. Ora tocca a '${comb.ordine_iniziativa[comb.indice_corrente].nome}' (Round: ${comb.round}).`,
                            combattimento: comb,
                            state
                        };
                    }
                    catch (err) {
                        return { status: "error", message: err.message };
                    }
                }
            }));
            // 15. Tool: rpg_combat_damage (alias: dnd_combat_damage)
            registerWithAlias("rpg_combat_damage", (ctx) => ({
                name: "rpg_combat_damage",
                label: "Apply Damage/Healing in Combat",
                description: "Applica danni (valore positivo) o cure (valore negativo) a un partecipante del combattimento.",
                parameters: {
                    type: "object",
                    properties: {
                        run_id: { type: "string", description: "L'ID della sessione attiva (opzionale)." },
                        nome: { type: "string", description: "Il nome del combattente che subisce il danno o la cura." },
                        valore: { type: "integer", description: "Punti ferita da sottrarre (es: 6) o aggiungere se negativo (es: -4 per cura)." }
                    },
                    required: ["nome", "valore"]
                },
                execute: async (_toolCallId, rawParams) => {
                    try {
                        const runId = rawParams.run_id || getActiveRunId(ctx?.sessionKey);
                        if (!runId) {
                            return { status: "error", message: "Nessuna run attiva trovata." };
                        }
                        const state = loadState(runId);
                        const targetName = characterKey(rawParams.nome);
                        const dmgVal = rawParams.valore;
                        let found = false;
                        let message = "";
                        const charKey = Object.keys(state.personaggi || {}).find(k => k === targetName);
                        if (charKey) {
                            const p = state.personaggi[charKey];
                            if (p && p.hp) {
                                const oldHp = p.hp.correnti;
                                p.hp.correnti = Math.max(0, Math.min(p.hp.max, p.hp.correnti - dmgVal));
                                found = true;
                                const diff = p.hp.correnti - oldHp;
                                message += `PG '${p.nome || charKey}': HP modificati di ${diff} (ora: ${p.hp.correnti}/${p.hp.max}). `;
                            }
                        }
                        if (state.combattimento && state.combattimento.attivo) {
                            const idx = state.combattimento.ordine_iniziativa.findIndex((c) => characterKey(c.nome) === targetName);
                            if (idx !== -1) {
                                const c = state.combattimento.ordine_iniziativa[idx];
                                if (c.hp) {
                                    const oldHp = c.hp.correnti;
                                    c.hp.correnti = Math.max(0, Math.min(c.hp.max, c.hp.correnti - dmgVal));
                                    found = true;
                                    const diff = c.hp.correnti - oldHp;
                                    if (!charKey) {
                                        message += `Combattente '${c.nome}': HP modificati di ${diff} (ora: ${c.hp.correnti}/${c.hp.max}). `;
                                    }
                                    if (c.hp.correnti === 0) {
                                        message += `[ATTENZIONE: ${c.nome} ha terminato i Punti Ferita!]; `;
                                    }
                                }
                            }
                        }
                        if (!found) {
                            return { status: "error", message: `Nessun combattente o personaggio trovato con il nome '${rawParams.nome}'.` };
                        }
                        saveState(runId, state, ctx?.sessionKey);
                        return {
                            status: "success",
                            message: message.trim(),
                            state
                        };
                    }
                    catch (err) {
                        return { status: "error", message: err.message };
                    }
                }
            }));
            // 16. Tool: rpg_combat_end (alias: dnd_combat_end)
            registerWithAlias("rpg_combat_end", (ctx) => ({
                name: "rpg_combat_end",
                label: "End Combat",
                description: "Termina il combattimento strutturato corrente, disattivando il tracker di iniziativa.",
                parameters: {
                    type: "object",
                    properties: {
                        run_id: { type: "string", description: "L'ID della sessione attiva (opzionale)." }
                    }
                },
                execute: async (_toolCallId, rawParams) => {
                    try {
                        const runId = rawParams.run_id || getActiveRunId(ctx?.sessionKey);
                        if (!runId) {
                            return { status: "error", message: "Nessuna run attiva trovata." };
                        }
                        const state = loadState(runId);
                        if (state.combattimento) {
                            state.combattimento.attivo = false;
                        }
                        saveState(runId, state, ctx?.sessionKey);
                        return {
                            status: "success",
                            message: "Combattimento terminato con successo. Ripristinata la modalità di esplorazione libera.",
                            state
                        };
                    }
                    catch (err) {
                        return { status: "error", message: err.message };
                    }
                }
            }));
            // 16b. Tool: rpg_set_combat_position (alias: dnd_set_combat_position)
            registerWithAlias("rpg_set_combat_position", (ctx) => ({
                name: "rpg_set_combat_position",
                label: "Set Combat Position",
                description: "Aggiorna la posizione (x, y) di un combattente sulla griglia della dashboard (0-indexed, max 7,5). Può anche impostare un emoji personalizzato per il token.",
                parameters: {
                    type: "object",
                    properties: {
                        run_id: { type: "string", description: "ID della run attiva (opzionale)." },
                        nome: { type: "string", description: "Nome del combattente da spostare." },
                        x: { type: "integer", description: "Colonna della griglia (0–7)." },
                        y: { type: "integer", description: "Riga della griglia (0–5)." },
                        emoji: { type: "string", description: "Emoji opzionale da mostrare come token (es: '🐉', '🧝', '💀')." }
                    },
                    required: ["nome", "x", "y"]
                },
                execute: async (_toolCallId, rawParams) => {
                    try {
                        const runId = rawParams.run_id || getActiveRunId(ctx?.sessionKey);
                        if (!runId) return { status: "error", message: "Nessuna run attiva trovata." };
                        const state = loadState(runId);
                        if (!state.combattimento?.attivo) return { status: "error", message: "Nessun combattimento attivo." };
                        const idx = state.combattimento.ordine_iniziativa.findIndex(c => characterKey(c.nome) === characterKey(rawParams.nome));
                        if (idx === -1) return { status: "error", message: `Combattente '${rawParams.nome}' non trovato nell'iniziativa.` };
                        state.combattimento.ordine_iniziativa[idx].x = Math.max(0, Math.min(7, rawParams.x));
                        state.combattimento.ordine_iniziativa[idx].y = Math.max(0, Math.min(5, rawParams.y));
                        if (rawParams.emoji) state.combattimento.ordine_iniziativa[idx].emoji = rawParams.emoji;
                        saveState(runId, state, ctx?.sessionKey);
                        return { status: "success", message: `${rawParams.nome} posizionato in (${rawParams.x}, ${rawParams.y}) sulla griglia.` };
                    } catch (err) {
                        return { status: "error", message: err.message };
                    }
                }
            }));
            // 17. Tool: rpg_restore_backup (alias: dnd_restore_backup)
            registerWithAlias("rpg_restore_backup", (ctx) => ({
                name: "rpg_restore_backup",
                label: "Restore Campaign Backup",
                description: "Elenca o ripristina uno dei salvataggi di backup automatici (stampa dei turni o ultimo di emergenza) per la campagna.",
                parameters: {
                    type: "object",
                    properties: {
                        run_id: { type: "string", description: "L'ID della run attiva (opzionale)." },
                        turno: { type: "integer", description: "Il numero del turno da ripristinare (es: 3)." },
                        backup_file: { type: "string", description: "Il nome esatto del file di backup da ripristinare (es: run-xxx_latest.json.bak)." },
                        list_only: { type: "boolean", default: false, description: "Se true, elenca solo i backup disponibili senza effettuare il ripristino." }
                    }
                },
                execute: async (_toolCallId, rawParams) => {
                    try {
                        const runId = rawParams.run_id || getActiveRunId(ctx?.sessionKey);
                        if (!runId) {
                            return { status: "error", message: "Nessuna run attiva trovata." };
                        }
                        ensureStateDir();
                        const safeRunId = validateRunId(runId);
                        const backupDir = join(stateDir, "backups", runId);
                        if (!existsSync(backupDir)) {
                            return { status: "success", message: "Nessun backup trovato per questa run.", backups: [] };
                        }
                        const backupFiles = readdirSync(backupDir).filter(f => f.endsWith(".json") || f.endsWith(".bak"));
                        if (rawParams.list_only) {
                            return {
                                status: "success",
                                message: `Trovati ${backupFiles.length} backup per la run ${runId}.`,
                                backups: backupFiles.sort()
                            };
                        }
                        let fileToRestore = "";
                        if (rawParams.backup_file) {
                            // Sanitize against path traversal: resolve and verify it stays inside backupDir
                            const candidate = resolve(backupDir, rawParams.backup_file);
                            const resolvedBackupDir = resolve(backupDir);
                            if (!candidate.startsWith(resolvedBackupDir + "\\") && !candidate.startsWith(resolvedBackupDir + "/")) {
                                return { status: "error", message: "Nome file di backup non valido (path traversal non consentito)." };
                            }
                            fileToRestore = candidate;
                        }
                        else if (rawParams.turno !== undefined && rawParams.turno !== null) {
                            const padTurn = String(rawParams.turno).padStart(4, "0");
                            const turnFile = backupFiles.find(f => f.includes(`_turno_${padTurn}.json`));
                            if (turnFile) {
                                fileToRestore = join(backupDir, turnFile);
                            }
                            else {
                                return { status: "error", message: `Nessun backup trovato per il turno ${rawParams.turno}.` };
                            }
                        }
                        else {
                            const latestFile = `${safeRunId}_latest.json.bak`;
                            if (backupFiles.includes(latestFile)) {
                                fileToRestore = join(backupDir, latestFile);
                            }
                            else {
                                return { status: "error", message: "Nessun backup di emergenza 'latest' trovato. Specifica un turno o un file." };
                            }
                        }
                        if (!fileToRestore || !existsSync(fileToRestore)) {
                            return { status: "error", message: `File di backup non trovato: ${fileToRestore}` };
                        }
                        const rawContent = readFileSync(fileToRestore, "utf-8");
                        const state = JSON.parse(rawContent);
                        const mainFile = runStateFile(safeRunId);
                        writeFileSync(mainFile, rawContent, "utf-8");
                        setActiveRunId(safeRunId, ctx?.sessionKey);
                        return {
                            status: "success",
                            message: `Salvataggio ripristinato con successo dal file '${fileToRestore}'. Il gioco è stato riportato al turno ${state.turno || 1}.`,
                            state
                        };
                    }
                    catch (err) {
                        return { status: "error", message: err.message };
                    }
                }
            }));
            // 18. Tool: rpg_narrate (alias: dnd_narrate)
            registerWithAlias("rpg_narrate", (ctx) => ({
                name: "rpg_narrate",
                label: "Narrate Speech (TTS)",
                description: "Riproduce la narrazione vocale in sintesi vocale (TTS) e ne salva il file audio nella campagna.",
                parameters: {
                    type: "object",
                    properties: {
                        run_id: { type: "string", description: "L'ID della sessione attiva (opzionale)." },
                        text: { type: "string", description: "Il testo narrativo da convertire in voce." },
                        play: { type: "boolean", default: true, description: "Se true, riproduce la narrazione dagli altoparlanti del PC." }
                    },
                    required: ["text"]
                },
                execute: async (_toolCallId, rawParams) => {
                    try {
                        const runId = rawParams.run_id || getActiveRunId(ctx?.sessionKey);
                        if (!runId) {
                            return { status: "error", message: "Nessuna run attiva trovata." };
                        }
                        ensureStateDir();
                        const audioDir = join(stateDir, "audio");
                        if (!existsSync(audioDir)) {
                            mkdirSync(audioDir, { recursive: true });
                        }
                        const textFilePath = join(audioDir, "narrate_temp.txt");
                        const wavFilePath = join(audioDir, `narrate_${Date.now()}.wav`);
                        writeFileSync(textFilePath, rawParams.text, "utf-8");
                        const ttsScript = join(wikiScriptDir, "tts_synthesize.ps1");
                        if (!existsSync(ttsScript)) {
                            return { status: "error", message: `Script di sintesi vocale non trovato in: ${ttsScript}` };
                        }
                        const playStr = rawParams.play !== false ? "true" : "false";
                        const args = [
                            "-ExecutionPolicy", "Bypass",
                            "-File", ttsScript,
                            "-textFilePath", textFilePath,
                            "-wavFilePath", wavFilePath,
                            "-play", playStr
                        ];
                        await execFileAsync("powershell.exe", args, { encoding: "utf-8", timeout: 45_000 });
                        try {
                            rmSync(textFilePath, { force: true });
                        }
                        catch { }
                        return {
                            status: "success",
                            message: "Narrazione vocale sintetizzata con successo.",
                            audio_file: wavFilePath,
                            text: rawParams.text
                        };
                    }
                    catch (err) {
                        return { status: "error", message: `Errore durante la sintesi vocale: ${err.message}` };
                    }
                }
            }));
            // 19. Tool: rpg_check_wiki (alias: dnd_check_wiki)
            registerWithAlias("rpg_check_wiki", (_ctx) => ({
                name: "rpg_check_wiki",
                label: "Wiki RAG Diagnostics",
                description: "Esegue una diagnostica completa del sistema Wiki RAG: Python, pacchetti, script, config, server FastAPI e database LanceDB.",
                parameters: {
                    type: "object",
                    properties: {}
                },
                execute: async (_toolCallId) => {
                    const checks = [];
                    let passed = 0;
                    const addCheck = (label, ok, note = "") => {
                        if (ok) passed++;
                        checks.push({ label, ok, note });
                    };
                    // Python
                    try {
                        const { stdout } = await execFileAsync(python, ["--version"], { encoding: "utf-8", timeout: 5_000 });
                        addCheck(`🐍 Python eseguibile: ${stdout.trim()} (${python})`, true);
                    }
                    catch {
                        addCheck(`🐍 Python eseguibile: ${python}`, false, `Non trovato. Configura 'pythonExecutable' in openclaw.json.`);
                    }
                    // Packages
                    const pkgs = [
                        { name: "lancedb", desc: "database vettoriale" },
                        { name: "sentence_transformers", desc: "embedding model" },
                        { name: "fastapi", desc: "server API" },
                        { name: "uvicorn", desc: "server ASGI" },
                        { name: "watchfiles", desc: "file watcher live" },
                        { name: "jose", desc: "JWT auth wiki" }
                    ];
                    for (const pkg of pkgs) {
                        try {
                            await execFileAsync(python, ["-c", `import ${pkg.name}`], { timeout: 8_000 });
                            addCheck(`📦 ${pkg.name}: OK (${pkg.desc})`, true);
                        }
                        catch {
                            addCheck(`📦 ${pkg.name}: Mancante! (${pkg.desc})`, false, `Usa 'rpg_install_dependencies' per installare tutte le dipendenze.`);
                        }
                    }
                    // Scripts
                    const scripts = [
                        { label: "wiki.py (core)", path: wikiPy },
                        { label: "wiki_context.py", path: wikiContextScript },
                        { label: "wiki_check_setup.py", path: checkSetupScript },
                        { label: "tts_synthesize.ps1", path: join(wikiScriptDir, "tts_synthesize.ps1") }
                    ];
                    for (const s of scripts) {
                        const ok = existsSync(s.path);
                        addCheck(`📄 Script: ${s.label}`, ok, ok ? "" : `Non trovato: ${s.path}`);
                    }
                    // Config
                    const cfgPath = join(wikiDataDir, "wiki.config.json");
                    let lancedbRelPath = "memory/lancedb";
                    try {
                        const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
                        lancedbRelPath = cfg.lancedb?.path || lancedbRelPath;
                        addCheck(`⚙️ wiki.config.json: Valido. LanceDB path: ${lancedbRelPath}`, true);
                    }
                    catch {
                        addCheck(`⚙️ wiki.config.json: Non trovato o non valido`, false, `Percorso: ${cfgPath}`);
                    }
                    // Server
                    try {
                        const resp = await fetch(`http://localhost:${serverPort}/`, { signal: AbortSignal.timeout(2_000) });
                        addCheck(`🌐 Server FastAPI (porta ${serverPort}): Risponde`, resp.ok || resp.status < 500);
                    }
                    catch {
                        addCheck(`🌐 Server FastAPI (porta ${serverPort}): Non risponde`, false, `Viene avviato automaticamente all'avvio della prima run.`);
                    }
                    // LanceDB
                    const lancedbAbsPath = join(wikiDataDir, lancedbRelPath);
                    const lancedbExists = existsSync(lancedbAbsPath);
                    let fileCount = 0;
                    if (lancedbExists) {
                        try { fileCount = readdirSync(lancedbAbsPath).length; } catch { }
                    }
                    if (lancedbExists && fileCount > 0) {
                        addCheck(`🗄️ LanceDB: ${fileCount} files indicizzati`, true);
                    }
                    else if (lancedbExists) {
                        addCheck(`🗄️ LanceDB: Esiste ma vuoto`, false, `Usa 'rpg_scan_manuals' per indicizzare manuali.`);
                    }
                    else {
                        addCheck(`🗄️ LanceDB: Non inizializzato`, false, `Directory non trovata: ${lancedbAbsPath}. Esegui wiki.py rebuild o riavvia il gateway.`);
                    }
                    const total = checks.length;
                    const problems = checks.filter(c => !c.ok);
                    const lines = checks.map(c => `${c.ok ? "✅" : "❌"} ${c.label}${c.note ? `\n   → ${c.note}` : ""}`);
                    const summary = problems.length === 0
                        ? `✅ Tutti i ${total} check superati. Il sistema Wiki RAG è pronto.`
                        : `⚠️ ${problems.length} problema/i rilevato/i su ${total} check.\n${problems.map(c => `  → ${c.note}`).join("\n")}`;
                    return {
                        status: problems.length === 0 ? "success" : "warning",
                        passed,
                        total,
                        report: `## 🔍 Diagnostica Wiki RAG — ${passed}/${total} check superati\n\n${lines.join("\n")}\n\n${summary}`,
                        problems: problems.map(c => c.note).filter(Boolean)
                    };
                }
            }));
        }
    }
});
