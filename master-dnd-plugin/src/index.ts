import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { existsSync, writeFileSync, readFileSync, mkdirSync, appendFileSync, readdirSync, rmSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Resolve current plugin directory (works for both ES module and compiled index.js)
const pluginDir = dirname(fileURLToPath(import.meta.url));
const wikiBackendDir = join(pluginDir, "wiki-backend");

interface RollResult {
  total: number;
  rolls: number[];
  rollsText: string;
  expression: string;
  modifier: number;
  advantage: string;
  explodedRolls?: number[];
}

function parseAndRoll(
  expression: string,
  adv: string = "none",
  explode: boolean = false
): RollResult {
  const normalizedAdv = adv.toLowerCase().trim();
  const advantageMode = 
    normalizedAdv === "vantaggio" || normalizedAdv === "advantage" ? "advantage" :
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

  // Validate dice parameters
  if (sides < 1) {
    throw new Error(`Numero di facce non valido: ${sides}. Deve essere >= 1 (es: 1d6, 2d20).`);
  }
  if (count < 1) {
    throw new Error(`Numero di dadi non valido: ${count}. Deve essere >= 1 (es: 1d6, 2d20).`);
  }

  const rollDie = () => Math.floor(Math.random() * sides) + 1;

  let rolls: number[] = [];
  let total = 0;
  let explodedRolls: number[] = [];

  if (sides === 20 && advantageMode !== "none") {
    const roll1 = rollDie();
    const roll2 = rollDie();
    rolls = [roll1, roll2];
    const kept = advantageMode === "advantage" ? Math.max(roll1, roll2) : Math.min(roll1, roll2);
    total = kept + modVal;
  } else {
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

const DANGEROUS_PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function setNestedValue(obj: any, path: string, value: any): void {
  const parts = path.split(".");
  // Guard against prototype pollution attacks
  for (const part of parts) {
    if (DANGEROUS_PROTO_KEYS.has(part)) {
      throw new Error(`Invalid path key '${part}': prototype pollution attempt detected.`);
    }
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

// Function to initialize wiki workspace under user specified data folder dynamically
function initWikiWorkspace(wikiDataDir: string, defaultCfgPath: string) {
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
  } else {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      if (cfg.workspace !== wikiDataDir.replace(/\\/g, "/")) {
        cfg.workspace = wikiDataDir.replace(/\\/g, "/");
        writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
      }
    } catch (e) {
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
    for (const file of ["wiki-core.md", "wiki-setup.md"]) {
      const srcFile = join(srcSkills, file);
      const destFile = join(destSkills, file);
      if (existsSync(srcFile) && !existsSync(destFile)) {
        try {
          writeFileSync(destFile, readFileSync(srcFile));
        } catch {}
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
      "rpg_roll", "dnd_roll",
      "rpg_start_run", "dnd_start_run",
      "rpg_save_state", "dnd_save_state",
      "rpg_load_state", "dnd_load_state",
      "rpg_get_sheet", "dnd_get_sheet",
      "rpg_update_state", "dnd_update_state",
      "rpg_log_turn", "dnd_log_turn",
      "rpg_install_dependencies", "dnd_install_dependencies",
      "rpg_scan_manuals", "dnd_scan_manuals",
      "rpg_list_runs", "dnd_list_runs",
      "rpg_create_character", "dnd_create_character",
      "rpg_combat_start", "dnd_combat_start",
      "rpg_combat_damage", "dnd_combat_damage",
      "rpg_combat_next_turn", "dnd_combat_next_turn",
      "rpg_combat_end", "dnd_combat_end",
      "rpg_restore_backup", "dnd_restore_backup",
      "rpg_narrate", "dnd_narrate",
      "rpg_wiki_process_raw", "dnd_wiki_process_raw",
      "rpg_check_wiki", "dnd_check_wiki",
      "rpg_set_combat_position", "dnd_set_combat_position"
    ]
  },

  register(api: any) {
    const cfg = ((api as Record<string, unknown>).pluginConfig ?? {}) as {
      stateDirectory?: string;
      wikiEnabled?: boolean;
      wikiDataDirectory?: string;
      pythonExecutable?: string;
      k?: number;
      maxChars?: number;
      serverPort?: number;
      debug?: boolean;
    };

    if (!cfg.stateDirectory) {
      console.warn("[master-dnd-plugin] stateDirectory configuration parameter is missing.");
      return;
    }

    const stateDir = cfg.stateDirectory;
    const wikiEnabled = cfg.wikiEnabled !== false;
    const python = cfg.pythonExecutable ?? "python";
    const k = String(cfg.k ?? 3);
    const maxChars = String(cfg.maxChars ?? 600);
    const serverPort = cfg.serverPort ?? 7331;
    const debug = cfg.debug === true;

    // Resolve wiki database directory: defaults to <stateDirectory>/wiki-data
    const wikiDataDir = cfg.wikiDataDirectory ? cfg.wikiDataDirectory : join(stateDir, "wiki-data");
    const debugLog = join(wikiDataDir, ".wiki-plugin-debug.log");

    const ensureStateDir = () => {
      if (!existsSync(stateDir)) {
        mkdirSync(stateDir, { recursive: true });
      }
    };

    const getActiveRunId = (sessionKey?: string): string | null => {
      ensureStateDir();
      const key = sessionKey ? sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_") : "default";
      const activeRunFile = join(stateDir, `active_run_${key}.json`);
      if (existsSync(activeRunFile)) {
        try {
          const content = JSON.parse(readFileSync(activeRunFile, "utf-8"));
          return content.active_run_id || null;
        } catch {}
      }
      const legacyFile = join(stateDir, "active_run.json");
      if (existsSync(legacyFile)) {
        try {
          const content = JSON.parse(readFileSync(legacyFile, "utf-8"));
          return content.active_run_id || null;
        } catch {}
      }
      return null;
    };

    const setActiveRunId = (runId: string, sessionKey?: string) => {
      ensureStateDir();
      const key = sessionKey ? sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_") : "default";
      const activeRunFile = join(stateDir, `active_run_${key}.json`);
      writeFileSync(activeRunFile, JSON.stringify({ active_run_id: runId }, null, 2), "utf-8");
      // Update legacy file for backward compatibility
      const legacyFile = join(stateDir, "active_run.json");
      writeFileSync(legacyFile, JSON.stringify({ active_run_id: runId }, null, 2), "utf-8");
    };

    const loadState = (runId: string): any => {
      ensureStateDir();
      // Sanitize runId to prevent path traversal
      const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const file = join(stateDir, `${safeRunId}.json`);
      if (!existsSync(file)) {
        throw new Error(`Session state file not found for run ID: ${runId}`);
      }
      return JSON.parse(readFileSync(file, "utf-8"));
    };

    const saveState = (runId: string, state: any, sessionKey?: string) => {
      ensureStateDir();
      // Sanitize runId to prevent path traversal
      const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const file = join(stateDir, `${safeRunId}.json`);
      
      try {
        // Create backup folder for this run
        const backupDir = join(stateDir, "backups", safeRunId);
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
            
            // 1. Save turn backup — avoid overwriting if already exists for this turn (preserve first state of turn)
            const turnBackupBase = join(backupDir, `${safeRunId}_turno_${padTurn}.json`);
            const turnBackupFile = existsSync(turnBackupBase)
              ? join(backupDir, `${safeRunId}_turno_${padTurn}_${Date.now()}.json`)
              : turnBackupBase;
            writeFileSync(turnBackupFile, rawContent, "utf-8");

            // 2. Save latest backup (runId_latest.json.bak)
            const latestBackupFile = join(backupDir, `${safeRunId}_latest.json.bak`);
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
                } catch {}
              }
            }
          } catch (e) {
            console.error(`[master-dnd-plugin] Error creating backup for run ${runId}:`, e);
          }
        }
      } catch (err) {
        console.error(`[master-dnd-plugin] Backup folder initialization error:`, err);
      }

      // Write the new state atomically (tmp + rename to avoid partial writes)
      const tmpFile = file + ".tmp";
      writeFileSync(tmpFile, JSON.stringify(state, null, 2), "utf-8");
      try {
        renameSync(tmpFile, file);
      } catch {
        // Fallback: direct write if rename fails (cross-device)
        writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
        try { rmSync(tmpFile, { force: true }); } catch {}
      }
      setActiveRunId(safeRunId, sessionKey);
    };

    // Python Wiki Paths mapping
    const wikiScriptDir = join(wikiBackendDir, "scripts");
    const wikiPy = join(wikiScriptDir, "wiki.py");
    const wikiContextScript = join(wikiScriptDir, "wiki_context.py");
    const checkSetupScript = join(wikiScriptDir, "wiki_check_setup.py");
    const defaultCfgPath = join(wikiBackendDir, "wiki.config.json");

    const sessionsBriefed = new Set<string>();
    // Per-session welcome gate: cleared on every gateway restart, so every new bot launch
    // always prompts the user to pick/start a run regardless of persisted active_run.json.
    const sessionsWelcomed = new Set<string>();

    // INITIALIZATION OF WIKI ENVIRONMENT
    if (wikiEnabled) {
      try {
        initWikiWorkspace(wikiDataDir, defaultCfgPath);
      } catch (err) {
        console.error("[master-dnd-plugin] Error initializing wiki workspace folders:", err);
      }

      // Startup: auto-check and auto-install Python dependencies if missing
      void (async () => {
        const requiredPkgs = "lancedb, sentence_transformers, fastapi, uvicorn, watchfiles, jose";
        try {
          await execFileAsync(python, ["-c", `import ${requiredPkgs}`], { timeout: 10_000 });
        } catch {
          console.log("[master-dnd-plugin] Some Python dependencies missing — auto-installing from requirements.txt...");
          const reqPath = join(wikiBackendDir, "requirements.txt");
          if (existsSync(reqPath)) {
            try {
              await execFileAsync(python, ["-m", "pip", "install", "-r", reqPath], { timeout: 300_000 });
              console.log("[master-dnd-plugin] Python dependencies installed successfully.");
            } catch (installErr: any) {
              console.error("[master-dnd-plugin] Auto-install failed:", installErr.message,
                `\nManual fix: ${python} -m pip install -r ${reqPath}`);
              if (debug) {
                try {
                  writeFileSync(debugLog, `[${new Date().toISOString()}] AUTO-INSTALL FAIL\n${installErr.message}\n`, "utf-8");
                } catch {}
              }
            }
          } else {
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
          } catch (rebuildErr: any) {
            console.error("[master-dnd-plugin] LanceDB auto-rebuild failed:", rebuildErr.message);
            if (debug) {
              try {
                appendFileSync(debugLog, `[${new Date().toISOString()}] LANCEDB REBUILD FAIL\n${rebuildErr.message}\n`, "utf-8");
              } catch {}
            }
          }
        }
      })();

      // Startup: spawn local python wiki server in background
      void (async () => {
        try {
          await fetch(`http://localhost:${serverPort}/`, { signal: AbortSignal.timeout(1_500) });
        } catch {
          if (existsSync(wikiPy)) {
            const child = spawn(
              python,
              [wikiPy, "serve", "--workspace", wikiDataDir, "--port", String(serverPort)],
              { stdio: "ignore" }
            );
            if (debug) {
              try {
                appendFileSync(debugLog, `[${new Date().toISOString()}] wiki server spawned (PID ${child.pid})\n`, "utf-8");
              } catch {}
            }
          }
        }
      })();
    }

    // Register combined before_prompt_build hook
    api.on(
      "before_prompt_build",
      async (event: any, ctx: any) => {
        const sessionKey = (ctx as any)?.sessionKey;
        const currentSessionKey = sessionKey || "global";

        // On the first message of every session (including after each gateway restart),
        // always show the welcome so the user can pick or start any run they want.
        if (!sessionsWelcomed.has(currentSessionKey)) {
          sessionsWelcomed.add(currentSessionKey);
          const welcomeInjection =
            `\n<rpg-welcome>\n` +
            `Benvenuto! Sei il Game Master automatico. Ogni volta che la chat si avvia devi obbligatoriamente proporre al giocatore di scegliere cosa fare — anche se esiste già una campagna salvata.\n` +
            `DEVI seguire questa procedura OBBLIGATORIA prima di qualsiasi narrazione:\n` +
            `1. Chiama SUBITO il tool 'rpg_list_runs' per ottenere l'elenco completo delle campagne salvate su disco.\n` +
            `2. Saluta il giocatore e presentagli le opzioni disponibili:\n` +
            `   a) Riprendere una campagna esistente — elencala con titolo, sistema, turno attuale e data di inizio.\n` +
            `   b) Avviare una NUOVA campagna — chiedi titolo, sistema di gioco (es. D&D 5e, Lady Blackbird, Cyberpunk, Fate…) e nome/classe del personaggio.\n` +
            `3. In base alla scelta del giocatore:\n` +
            `   - Riprendere → chiama 'rpg_load_state' con il run_id scelto.\n` +
            `   - Nuova campagna → raccogli i dati necessari, poi chiama 'rpg_start_run'.\n` +
            `REGOLA ASSOLUTA: NON iniziare a narrare alcuna avventura finché non hai chiamato con successo 'rpg_load_state' o 'rpg_start_run' e ricevuto una risposta di successo.\n` +
            `</rpg-welcome>\n`;
          return { prependContext: welcomeInjection };
        }

        // Session already welcomed — resume normal flow.
        const activeRunId = getActiveRunId(sessionKey);
        if (!activeRunId) {
          // Player hasn't picked a run yet in this session — inject a lighter nudge.
          return {
            prependContext:
              `\n<rpg-reminder>\n` +
              `Nessuna sessione attiva. Chiama 'rpg_list_runs' e lascia che il giocatore scelga o avvii una campagna prima di narrare.\n` +
              `</rpg-reminder>\n`
          };
        }

        const ev = event as Record<string, unknown>;
        const userText: string =
          ev.userMessage as string ??
          ev.prompt as string ??
          ev.currentPrompt as string ??
          ev.input as string ??
          ev.message as string ??
          ev.text as string ??
          "";

        const parts: string[] = [];

        // 1. INJECT STATE JSON (UNIVERSAL)
        let activeSystem = "dnd5e";
        let characterWizardInjection = "";
        let combatInjection = "";
        try {
          const state = loadState(activeRunId);
          activeSystem = state.sistema || state.system || "dnd5e";
          const formattedState = JSON.stringify(state, null, 2);
          const stateInjection = 
            `\n<rpg-state>\n` +
            `Informazioni sullo stato della partita GDR (Sistema: ${activeSystem}, Run ID: ${activeRunId}, Turno: ${state.turno || 0}):\n` +
            `${formattedState}\n` +
            `\n` +
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
            `- MEMORIA VETTORIALE (STORICO DEI TURNI): Al termine di ogni risposta narrativa (dopo l'esito delle azioni del giocatore), devi SEMPRE chiamare il tool 'rpg_log_turn' (o il suo alias 'dnd_log_turn') per salvare la sintesi del turno corrente. Il tool farà avanzare il contatore del turno nel JSON di stato.\n` +
            `- CREAZIONE DI LORE E NPC DA PARTE DEL GIOCATORE: Ricorda al giocatore che può creare NPC e lore in due modi: 1) descrivendoli direttamente in chat (tu li registrerai in 'mondo.npcs_incontrati' e nei riassunti di turno), o 2) inserendo file Markdown dettagliati sotto 'wiki-works/avventure/${activeRunId}/entities/<nome-npc>.md' (che verranno indicizzati e richiamati dal RAG quando citati in chat).\n` +
            `- COMPAGNI E PARTY MULTIPLAYER: La sessione supporta più personaggi giocanti sotto 'personaggi'. Ciascuno è legato al rispettivo giocatore. Se un NPC si unisce al gruppo come compagno d'avventura attivo nei combattimenti (con HP, CA e statistiche), registralo come personaggio usando il tool 'rpg_create_character' impostando 'giocatore' su '@NPC' o '@Master'. Se è un compagno solo narrativo, inseriscilo in 'mondo.npcs_incontrati' con stato 'alleato' o 'compagno'.\n` +
            `- NARRAZIONE VOCALE (TTS): Se il giocatore chiede esplicitamente di ascoltare la narrazione o dice parole chiave come 'leggi', 'parla', 'voce', 'narra', usa il tool 'rpg_narrate' (o 'dnd_narrate') passando il tuo testo narrativo per riprodurlo a voce dagli altoparlanti del suo computer.\n` +
            `</rpg-state>\n`;
          parts.push(stateInjection);

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
            if (!Array.isArray(comb.ordine_iniziativa) || comb.ordine_iniziativa.length === 0) {
              combatInjection = `\n<rpg-combat>\nATTENZIONE: Combattimento attivo ma ordine iniziativa non disponibile o corrotto (Round: ${comb.round}).\n</rpg-combat>\n`;
            } else {
            const orderList = comb.ordine_iniziativa.map((c: any, idx: number) => {
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
            } // end ordine_iniziativa guard
          }
        } catch (err) {
          console.error(`[master-dnd-plugin] Error loading state for inject:`, err);
        }

        // 2. INJECT WIKI RAG CONTEXT (if enabled and user prompt is not empty)
        if (wikiEnabled && userText.trim()) {
          // A. Session Briefing (First prompt of session only)
          const currentSessionKey = (ctx as any)?.sessionKey || "global";
          if (!sessionsBriefed.has(currentSessionKey)) {
            sessionsBriefed.add(currentSessionKey);
            if (existsSync(checkSetupScript)) {
              try {
                const { stdout } = await execFileAsync(
                  python,
                  [checkSetupScript, "--workspace", wikiDataDir],
                  { encoding: "utf-8", timeout: 15_000 }
                );
                const briefing = stdout.trim();
                if (briefing) parts.push(briefing);
              } catch {
                // Fail silently
              }
            }
          }

          // B. Wiki Context Retrieval
          let contextInjected = false;
          // Attempt fast HTTP call to FastAPI server
          try {
            const runIdParam = activeRunId ? `&run_id=${encodeURIComponent(activeRunId)}` : "";
            const url = `http://localhost:${serverPort}/api/context?q=${encodeURIComponent(userText)}&k=${k}&max_chars=${maxChars}${runIdParam}`;
            const resp = await fetch(url, { signal: AbortSignal.timeout(3_000) });
            if (resp.ok) {
              const text = (await resp.text()).trim();
              if (text) {
                parts.push(text);
                contextInjected = true;
              }
            }
          } catch {
            // Server not responding, fall through to CLI subprocess
          }

          // Subprocess fallback if HTTP failed
          if (!contextInjected && existsSync(wikiContextScript)) {
            try {
              const result = await execFileAsync(
                python,
                [
                  wikiContextScript,
                  "--workspace", wikiDataDir,
                  "--q", userText,
                  "--k", k,
                  "--max-chars", maxChars,
                  ...(activeRunId ? ["--run-id", activeRunId] : [])
                ],
                { encoding: "utf-8", timeout: 15_000 }
              );
              const context = result.stdout.trim();
              if (context) parts.push(context);
            } catch (err) {
              if (debug) {
                try {
                  appendFileSync(debugLog, `[${new Date().toISOString()}] wiki_context.py error: ${String(err)}\n`, "utf-8");
                } catch {}
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
      },
      { priority: 55 }
    );

    // Register Tools with Alias Helper
    if (typeof (api as Record<string, unknown>).registerTool === "function") {
      const apiT = api as any;

      const registerWithAlias = (name: string, factory: (ctx?: any) => any) => {
        // Register primary tool (rpg_*)
        apiT.registerTool((ctx: any) => factory(ctx), { name });

        // Register retrocompatible alias (dnd_*)
        if (name.startsWith("rpg_")) {
          const aliasName = name.replace("rpg_", "dnd_");
          const aliasFactory = (ctx: any) => {
            const def = { ...factory(ctx) };  // shallow copy to avoid mutating the primary tool definition
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
        execute: async (_toolCallId: string, rawParams: any) => {
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
          } catch (err: any) {
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
        execute: async (_toolCallId: string, rawParams: any) => {
          try {
            const runId = rawParams.run_id || `run-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${Math.random().toString(36).substring(2, 6)}`;
            const sistema = rawParams.sistema || "dnd5e";

            let personaggi: Record<string, any> = {};

            if (rawParams.scheda_personaggio) {
              // If scheda_personaggio already looks like a keyed map {charName: {...}}, use it directly.
              // Otherwise (flat object like {nome: "Eldrin", classe: "Mago"}), wrap it under giocatore key.
              const isKeyedMap = Object.values(rawParams.scheda_personaggio).some(
                (v) => typeof v === "object" && v !== null && !Array.isArray(v)
              );
              if (isKeyedMap) {
                personaggi = rawParams.scheda_personaggio;
              } else {
                const charKey = (rawParams.scheda_personaggio.nome ||
                                 rawParams.character_name ||
                                 rawParams.giocatore ||
                                 "personaggio").toLowerCase().trim().replace(/\s+/g, "_");
                personaggi = { [charKey]: { giocatore: rawParams.giocatore, ...rawParams.scheda_personaggio } };
              }
            } else if (rawParams.character_name) {
              // Map old D&D parameters to character sheet
              const charName = rawParams.character_name.toLowerCase().trim();
              const level = rawParams.livello || 1;
              const hpMax = rawParams.hp_max || 10;
              const ca = rawParams.ca || 10;
              const defaultStats = { for: 10, des: 10, cos: 10, int: 10, sag: 10, car: 10 };
              const stats = rawParams.stats ? { ...defaultStats, ...rawParams.stats } : defaultStats;
              const inventory = rawParams.inventario || ["Vestiti comuni", "Razioni (5)"];

              personaggi = {
                [charName]: {
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

            saveState(runId, newState, (ctx as any)?.sessionKey);

            // Avvia la scansione dei manuali e delle avventure in background all'avvio
            const watcherScript = join(wikiScriptDir, "wiki_manuals_watcher.py");
            if (existsSync(watcherScript)) {
              try {
                const child = spawn(python, [watcherScript, "--workspace", wikiDataDir], {
                  stdio: "ignore"
                });
                child.unref();
              } catch {}
            }

            return { status: "success", run_id: runId, state: newState };
          } catch (err: any) {
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
        execute: async (_toolCallId: string, rawParams: any) => {
          try {
            saveState(rawParams.run_id, rawParams.state, (ctx as any)?.sessionKey);
            return { status: "success", run_id: rawParams.run_id, message: "Stato salvato con successo." };
          } catch (err: any) {
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
        execute: async (_toolCallId: string, rawParams: any) => {
          try {
            const state = loadState(rawParams.run_id);
            setActiveRunId(rawParams.run_id, (ctx as any)?.sessionKey);

            // Avvia la scansione dei manuali e delle avventure in background al caricamento
            const watcherScript = join(wikiScriptDir, "wiki_manuals_watcher.py");
            if (existsSync(watcherScript)) {
              try {
                const child = spawn(python, [watcherScript, "--workspace", wikiDataDir], {
                  stdio: "ignore"
                });
                child.unref();
              } catch {}
            }

            return { status: "success", run_id: rawParams.run_id, state };
          } catch (err: any) {
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
        execute: async (_toolCallId: string, rawParams: any) => {
          try {
            const state = loadState(rawParams.run_id);
            return { status: "success", personaggi: state.personaggi };
          } catch (err: any) {
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
        execute: async (_toolCallId: string, rawParams: any) => {
          try {
            const state = loadState(rawParams.run_id);
            setNestedValue(state, rawParams.path, rawParams.value);
            saveState(rawParams.run_id, state, (ctx as any)?.sessionKey);
            return { status: "success", run_id: rawParams.run_id, state };
          } catch (err: any) {
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
        execute: async (_toolCallId: string, rawParams: any) => {
          if (!wikiEnabled) {
            return { status: "error", message: "Wiki RAG non abilitata." };
          }
          const activeRunId = getActiveRunId((ctx as any)?.sessionKey);
          if (!activeRunId) {
            return { status: "error", message: "Nessuna run attiva trovata. Avvia prima una run con rpg_start_run." };
          }

          try {
            const state = loadState(activeRunId);
            const turno = state.turno || 1;

            const padTurno = String(turno).padStart(4, "0");
            const relPath = `wiki-works/avventure/${activeRunId}/synthesis/turno-${padTurno}.md`;
            const tmpFileAbs = join(wikiDataDir, `${relPath}.tmp`);

            if (!existsSync(wikiPy)) {
              return { status: "error", message: `Script wiki.py non trovato.` };
            }

            const parentDir = dirname(tmpFileAbs);
            if (!existsSync(parentDir)) {
              mkdirSync(parentDir, { recursive: true });
            }

            const fileContent = `# Turno ${turno} — Sintesi\n\n${rawParams.synthesis}\n`;
            writeFileSync(tmpFileAbs, fileContent, "utf-8");

            const args = [
              wikiPy,
              "ingest",
              "--workspace", wikiDataDir,
              "--pages", `${relPath}.tmp`,
              "--log", `Turn ${turno} logged automatically for run ${activeRunId}`
            ];

            // Increment and save BEFORE ingest: the narrative turn happened regardless of RAG indexing success
            state.turno = turno + 1;
            saveState(activeRunId, state, (ctx as any)?.sessionKey);

            let ingestOutput = "";
            let ingestWarning = "";
            try {
              const { stdout } = await execFileAsync(python, args, { encoding: "utf-8", timeout: 30_000 });
              ingestOutput = stdout.trim();
            } catch (ingestErr: any) {
              ingestWarning = ` (ATTENZIONE: indicizzazione RAG fallita: ${ingestErr.message} — il turno è comunque salvato)`;
            }

            return {
              status: "success",
              message: `Turno ${turno} registrato con successo. Il prossimo turno sarà il turno ${state.turno}.${ingestWarning}`,
              relPath,
              output: ingestOutput
            };
          } catch (err: any) {
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
        execute: async (_toolCallId: string, params: { project?: string }) => {
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
            try {
              return JSON.parse(stdout);
            } catch {
              return { status: "error", message: "Lo script Python ha restituito output non-JSON.", raw: stdout.trim() };
            }
          } catch (err: any) {
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
        execute: async (_toolCallId: string) => {
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
          } catch (err: any) {
            return {
              status: "error",
              message: `Impossibile installare le dipendenze: ${err.message}`,
              stdout: err.stdout || "",
              stderr: err.stderr || ""
            };
          }
        }
      }));

      // 9b. Tool: rpg_check_wiki (alias: dnd_check_wiki)
      registerWithAlias("rpg_check_wiki", (_ctx) => ({
        name: "rpg_check_wiki",
        label: "Check Wiki RAG Setup",
        description: "Verifica l'installazione completa della Wiki RAG: Python, librerie necessarie, script backend, config, server FastAPI e database LanceDB. Utile per diagnosticare problemi prima di giocare.",
        parameters: {
          type: "object",
          properties: {}
        },
        execute: async (_toolCallId: string) => {
          const results: { check: string; ok: boolean; detail: string }[] = [];
          const addCheck = (check: string, ok: boolean, detail: string) =>
            results.push({ check, ok, detail });

          // ── 1. Python executable ──────────────────────────────────────────────
          try {
            const { stdout } = await execFileAsync(python, ["--version"], {
              encoding: "utf-8", timeout: 5_000
            });
            addCheck("Python eseguibile", true, (stdout.trim() || "OK") + ` (${python})`);
          } catch (e: any) {
            addCheck("Python eseguibile", false,
              `Non trovato o non eseguibile: '${python}'. ` +
              `Imposta 'pythonExecutable' in openclaw.json (es: "py", "python3", percorso assoluto).`);
          }

          // ── 2. Librerie Python necessarie ────────────────────────────────────
          const requiredPackages: { pkg: string; pip: string; note?: string }[] = [
            { pkg: "lancedb",              pip: "lancedb",                   note: "database vettoriale" },
            { pkg: "sentence_transformers",pip: "sentence-transformers",     note: "embedding model" },
            { pkg: "fastapi",              pip: "fastapi",                   note: "server RAG" },
            { pkg: "uvicorn",              pip: "uvicorn[standard]",         note: "server ASGI" },
            { pkg: "watchfiles",           pip: "watchfiles",                note: "file watcher live" },
            { pkg: "jose",                 pip: "python-jose[cryptography]", note: "JWT auth wiki" },
          ];

          for (const { pkg, pip, note } of requiredPackages) {
            try {
              await execFileAsync(python, ["-c", `import ${pkg}`], {
                encoding: "utf-8", timeout: 8_000
              });
              addCheck(`Pacchetto: ${pkg}`, true, note ? `OK (${note})` : "OK");
            } catch {
              addCheck(`Pacchetto: ${pkg}`, false,
                `Mancante! Installa con: pip install ${pip}` +
                (note ? ` (${note})` : "") +
                ` — oppure usa il tool 'rpg_install_dependencies'.`);
            }
          }

          // ── 3. Script backend presenti ───────────────────────────────────────
          const scripts: { name: string; path: string }[] = [
            { name: "wiki.py (core)",             path: wikiPy },
            { name: "wiki_context.py (CLI RAG)",  path: wikiContextScript },
            { name: "wiki_check_setup.py",        path: checkSetupScript },
            { name: "tts_synthesize.ps1 (TTS)",   path: join(wikiScriptDir, "tts_synthesize.ps1") },
          ];
          for (const { name, path } of scripts) {
            const ok = existsSync(path);
            addCheck(`Script: ${name}`, ok,
              ok ? path : `NON TROVATO in: ${path} — reinstalla il plugin.`);
          }

          // ── 4. Wiki config valida ────────────────────────────────────────────
          const cfgPath = join(wikiDataDir, "wiki.config.json");
          if (!existsSync(cfgPath)) {
            addCheck("wiki.config.json", false,
              `File non trovato in: ${wikiDataDir} — il workspace non è ancora inizializzato. ` +
              `Avvia una run con 'rpg_start_run' per crearlo automaticamente.`);
          } else {
            try {
              const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
              const hasLancedb = !!cfg?.lancedb?.path;
              addCheck("wiki.config.json", hasLancedb,
                hasLancedb
                  ? `Valido. LanceDB path: ${cfg.lancedb.path}`
                  : "Trovato ma manca la sezione 'lancedb.path' — il file potrebbe essere corrotto.");
            } catch {
              addCheck("wiki.config.json", false, "Trovato ma non è un JSON valido — cancellalo e riavvia.");
            }
          }

          // ── 5. Server FastAPI raggiungibile ──────────────────────────────────
          try {
            const resp = await fetch(`http://localhost:${serverPort}/`, {
              signal: AbortSignal.timeout(2_000)
            });
            addCheck(`Server FastAPI (porta ${serverPort})`, resp.ok || resp.status < 500,
              `Raggiungibile (HTTP ${resp.status}).`);
          } catch {
            addCheck(`Server FastAPI (porta ${serverPort})`, false,
              `Non risponde su http://localhost:${serverPort}/. ` +
              `Il server viene avviato automaticamente da OpenClaw alla prima run, oppure puoi avviarlo manualmente con: ` +
              `python wiki-backend/scripts/wiki.py serve --workspace "${wikiDataDir}" --port ${serverPort}`);
          }

          // ── 6. Database LanceDB con dati ─────────────────────────────────────
          let lancedbOk = false;
          let lancedbDetail = "";
          try {
            const cfgRaw = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf-8")) : null;
            const lancedbPath = cfgRaw?.lancedb?.path
              ? join(wikiDataDir, cfgRaw.lancedb.path)
              : join(wikiDataDir, "memory", "lancedb");
            if (!existsSync(lancedbPath)) {
              lancedbDetail = `Directory non trovata: ${lancedbPath}. Il database sarà creato al primo ingest.`;
            } else {
              const { stdout } = await execFileAsync(python, [
                "-c",
                `import lancedb, json, os; db=lancedb.connect(r"${lancedbPath}"); ` +
                `tables=list(db.list_tables()); ` +
                `rows=db.open_table("wiki_pages").count_rows() if "wiki_pages" in tables else 0; ` +
                `print(json.dumps({"tables": tables, "chunks": rows}))`
              ], { encoding: "utf-8", timeout: 15_000 });
              const info = JSON.parse(stdout.trim());
              lancedbOk = info.chunks > 0;
              lancedbDetail = `Tabelle: ${info.tables.join(", ") || "nessuna"} — Chunk indicizzati: ${info.chunks}` +
                (info.chunks === 0
                  ? ". Database vuoto: usa 'rpg_scan_manuals' per indicizzare manuali o 'rpg_log_turn' durante il gioco."
                  : ".");
            }
          } catch (e: any) {
            lancedbDetail = `Errore durante la lettura del database: ${e.message}`;
          }
          addCheck("LanceDB (dati indicizzati)", lancedbOk, lancedbDetail);

          // ── Componi il report ────────────────────────────────────────────────
          const total   = results.length;
          const passed  = results.filter(r => r.ok).length;
          const failed  = total - passed;
          const allOk   = failed === 0;

          const lines: string[] = [
            `## 🔍 Diagnostica Wiki RAG — ${passed}/${total} check superati`,
            "",
          ];
          for (const r of results) {
            const icon = r.ok ? "✅" : "❌";
            lines.push(`${icon} **${r.check}**: ${r.detail}`);
          }
          lines.push("");

          if (allOk) {
            lines.push("🎉 **Tutto in ordine!** La Wiki RAG è pronta. Puoi usare la memoria vettoriale durante il gioco.");
          } else {
            lines.push(`⚠️ **${failed} problema/i rilevato/i.** Suggerimenti:`);
            if (results.some(r => !r.ok && r.check.startsWith("Pacchetto:"))) {
              lines.push("  → Usa il tool `rpg_install_dependencies` per installare tutte le librerie Python in un colpo solo.");
            }
            if (results.some(r => !r.ok && r.check === "Python eseguibile")) {
              lines.push(`  → Aggiungi \`\"pythonExecutable\": \"python\"\` (o il path corretto) nel config del plugin in openclaw.json.`);
            }
            if (results.some(r => !r.ok && r.check.startsWith("Server FastAPI"))) {
              lines.push("  → Il server viene avviato automaticamente alla prima run. Se non parte, controlla i log.");
            }
            lines.push("");
            lines.push("Puoi giocare anche senza la Wiki RAG: dadi, combattimento, backup e TTS funzionano indipendentemente.");
          }

          return {
            status: allOk ? "ok" : "partial",
            passed,
            failed,
            total,
            report: lines.join("\n"),
            checks: results
          };
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
        execute: async (_toolCallId: string) => {
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
            try {
              return JSON.parse(stdout);
            } catch {
              return { status: "error", message: "Lo script Python ha restituito output non-JSON.", raw: stdout.trim() };
            }
          } catch (err: any) {
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
        execute: async (_toolCallId: string) => {
          try {
            ensureStateDir();
            const files = readdirSync(stateDir);
            const runs = [];
            
            for (const file of files) {
              // Exclude active_run.json and active_run_<sessionKey>.json files (Phase 7 multi-session)
              if (file.endsWith(".json") && !file.startsWith("active_run") && file !== ".registry.json") {
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
                } catch {
                  // Salta file corrotti
                }
              }
            }
            return { status: "success", runs };
          } catch (err: any) {
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
            scheda_personaggio: {
              type: "object",
              description: "La scheda personaggio completa in formato JSON. Può seguire il tracciato D&D o una struttura libera del sistema scelto."
            }
          },
          required: ["character_name", "giocatore", "scheda_personaggio"]
        },
        execute: async (_toolCallId: string, rawParams: any) => {
          try {
            const runId = rawParams.run_id || getActiveRunId((ctx as any)?.sessionKey);
            if (!runId) {
              return { status: "error", message: "Nessuna run attiva trovata per registrare il personaggio." };
            }
            const state = loadState(runId);
            if (!state.personaggi) {
              state.personaggi = {};
            }
            const charNameKey = rawParams.character_name.toLowerCase().trim();
            
            state.personaggi[charNameKey] = {
              ...rawParams.scheda_personaggio,
              giocatore: rawParams.giocatore,  // always wins over scheda spread
            };

            saveState(runId, state, (ctx as any)?.sessionKey);
            return {
              status: "success",
              message: `Personaggio '${rawParams.character_name}' salvato con successo nella run '${runId}'.`,
              state
            };
          } catch (err: any) {
            return { status: "error", message: err.message };
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
        execute: async (_toolCallId: string, rawParams: any) => {
          try {
            const runId = rawParams.run_id || getActiveRunId((ctx as any)?.sessionKey);
            if (!runId) {
              return { status: "error", message: "Nessuna run attiva trovata per iniziare il combattimento." };
            }
            const state = loadState(runId);
            
            const combattentiElaborati = rawParams.combattenti.map((c: any) => {
              let initVal = c.iniziativa;
              if (initVal === undefined || initVal === null) {
                initVal = Math.floor(Math.random() * 20) + 1;
              }
              
              let hp = undefined;
              if (c.tipo === "giocatore") {
                const charKey = c.nome.toLowerCase().trim();
                const p = state.personaggi?.[charKey];
                if (p && p.hp) {
                  hp = { max: p.hp.max, correnti: p.hp.correnti };
                } else {
                  hp = { max: 10, correnti: 10 };
                }
              } else {
                const maxHp = (c.hp_max !== undefined && c.hp_max !== null) ? c.hp_max : 10;
                hp = { max: maxHp, correnti: maxHp };
              }

              return {
                nome: c.nome,
                iniziativa: initVal,
                tipo: c.tipo,
                hp
              };
            });

            combattentiElaborati.sort((a: any, b: any) => b.iniziativa - a.iniziativa);

            state.combattimento = {
              attivo: true,
              round: 1,
              ordine_iniziativa: combattentiElaborati,
              indice_corrente: 0
            };

            saveState(runId, state, (ctx as any)?.sessionKey);
            return {
              status: "success",
              message: "Combattimento iniziato con successo. Ordine di iniziativa calcolato.",
              combattimento: state.combattimento,
              state
            };
          } catch (err: any) {
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
        execute: async (_toolCallId: string, rawParams: any) => {
          try {
            const runId = rawParams.run_id || getActiveRunId((ctx as any)?.sessionKey);
            if (!runId) {
              return { status: "error", message: "Nessuna run attiva trovata." };
            }
            const state = loadState(runId);
            if (!state.combattimento || !state.combattimento.attivo) {
              return { status: "error", message: "Nessun combattimento attivo in questa sessione." };
            }

            const comb = state.combattimento;
            // Guard against empty or corrupted initiative order
            if (!Array.isArray(comb.ordine_iniziativa) || comb.ordine_iniziativa.length === 0) {
              return { status: "error", message: "Ordine di iniziativa vuoto o corrotto. Verifica lo stato del combattimento." };
            }
            comb.indice_corrente += 1;
            if (comb.indice_corrente >= comb.ordine_iniziativa.length) {
              comb.indice_corrente = 0;
              comb.round += 1;
            }

            saveState(runId, state, (ctx as any)?.sessionKey);
            return {
              status: "success",
              message: `Turno avanzato. Ora tocca a '${comb.ordine_iniziativa[comb.indice_corrente].nome}' (Round: ${comb.round}).`,
              combattimento: comb,
              state
            };
          } catch (err: any) {
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
        execute: async (_toolCallId: string, rawParams: any) => {
          try {
            const runId = rawParams.run_id || getActiveRunId((ctx as any)?.sessionKey);
            if (!runId) {
              return { status: "error", message: "Nessuna run attiva trovata." };
            }
            const state = loadState(runId);
            const targetName = rawParams.nome.toLowerCase().trim();
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
              const idx = state.combattimento.ordine_iniziativa.findIndex((c: any) => c.nome.toLowerCase().trim() === targetName);
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

            saveState(runId, state, (ctx as any)?.sessionKey);
            return {
              status: "success",
              message: message.trim(),
              state
            };
          } catch (err: any) {
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
        execute: async (_toolCallId: string, rawParams: any) => {
          try {
            const runId = rawParams.run_id || getActiveRunId((ctx as any)?.sessionKey);
            if (!runId) {
              return { status: "error", message: "Nessuna run attiva trovata." };
            }
            const state = loadState(runId);
            if (state.combattimento) {
              state.combattimento.attivo = false;
            }

            saveState(runId, state, (ctx as any)?.sessionKey);
            return {
              status: "success",
              message: "Combattimento terminato con successo. Ripristinata la modalità di esplorazione libera.",
              state
            };
          } catch (err: any) {
            return { status: "error", message: err.message };
          }
        }
      }));

      // 16b. Tool: rpg_set_combat_position (alias: dnd_set_combat_position)
      registerWithAlias("rpg_set_combat_position", (ctx) => ({
        name: "rpg_set_combat_position",
        label: "Set Combat Position",
        description: "Aggiorna la posizione (x, y) di un combattente sulla griglia della dashboard (0-indexed, max 7,5). Puo anche impostare un emoji personalizzato per il token.",
        parameters: {
          type: "object",
          properties: {
            run_id: { type: "string", description: "ID della run attiva (opzionale)." },
            nome: { type: "string", description: "Nome del combattente da spostare." },
            x: { type: "integer", description: "Colonna della griglia (0-7)." },
            y: { type: "integer", description: "Riga della griglia (0-5)." },
            emoji: { type: "string", description: "Emoji opzionale da mostrare come token." }
          },
          required: ["nome", "x", "y"]
        },
        execute: async (_toolCallId: string, rawParams: any) => {
          try {
            const runId = rawParams.run_id || getActiveRunId((ctx as any)?.sessionKey);
            if (!runId) return { status: "error", message: "Nessuna run attiva trovata." };
            const state = loadState(runId);
            if (!state.combattimento?.attivo) return { status: "error", message: "Nessun combattimento attivo." };

            const idx = state.combattimento.ordine_iniziativa.findIndex(
              (c: any) => c.nome.toLowerCase() === String(rawParams.nome).toLowerCase()
            );
            if (idx === -1) {
              return { status: "error", message: `Combattente '${rawParams.nome}' non trovato nell'iniziativa.` };
            }

            const x = Math.max(0, Math.min(7, Number(rawParams.x)));
            const y = Math.max(0, Math.min(5, Number(rawParams.y)));
            state.combattimento.ordine_iniziativa[idx].x = x;
            state.combattimento.ordine_iniziativa[idx].y = y;
            if (rawParams.emoji) state.combattimento.ordine_iniziativa[idx].emoji = rawParams.emoji;

            saveState(runId, state, (ctx as any)?.sessionKey);
            return { status: "success", message: `${rawParams.nome} posizionato in (${x}, ${y}) sulla griglia.` };
          } catch (err: any) {
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
        execute: async (_toolCallId: string, rawParams: any) => {
          try {
            const runId = rawParams.run_id || getActiveRunId((ctx as any)?.sessionKey);
            if (!runId) {
              return { status: "error", message: "Nessuna run attiva trovata." };
            }
            ensureStateDir();
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
            } else if (rawParams.turno !== undefined && rawParams.turno !== null) {
              const padTurn = String(rawParams.turno).padStart(4, "0");
              const turnFile = backupFiles.find(f => f.includes(`_turno_${padTurn}.json`));
              if (turnFile) {
                fileToRestore = join(backupDir, turnFile);
              } else {
                return { status: "error", message: `Nessun backup trovato per il turno ${rawParams.turno}.` };
              }
            } else {
              const latestFile = `${runId}_latest.json.bak`;
              if (backupFiles.includes(latestFile)) {
                fileToRestore = join(backupDir, latestFile);
              } else {
                return { status: "error", message: "Nessun backup di emergenza 'latest' trovato. Specifica un turno o un file." };
              }
            }

            if (!fileToRestore || !existsSync(fileToRestore)) {
              return { status: "error", message: `File di backup non trovato: ${fileToRestore}` };
            }

            const rawContent = readFileSync(fileToRestore, "utf-8");
            const state = JSON.parse(rawContent);
            
            const mainFile = join(stateDir, `${runId}.json`);
            writeFileSync(mainFile, rawContent, "utf-8");
            setActiveRunId(runId, (ctx as any)?.sessionKey);

            return {
              status: "success",
              message: `Salvataggio ripristinato con successo dal file '${fileToRestore}'. Il gioco è stato riportato al turno ${state.turno || 1}.`,
              state
            };
          } catch (err: any) {
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
        execute: async (_toolCallId: string, rawParams: any) => {
          try {
            const runId = rawParams.run_id || getActiveRunId((ctx as any)?.sessionKey);
            if (!runId) {
              return { status: "error", message: "Nessuna run attiva trovata." };
            }
            ensureStateDir();
            const audioDir = join(stateDir, "audio");
            if (!existsSync(audioDir)) {
              mkdirSync(audioDir, { recursive: true });
            }

            // Check TTS script BEFORE writing temp file
            const ttsScript = join(wikiScriptDir, "tts_synthesize.ps1");
            if (!existsSync(ttsScript)) {
              return { status: "error", message: `Script di sintesi vocale non trovato in: ${ttsScript}` };
            }

            // Use unique temp filename to avoid race conditions on concurrent narrate calls
            const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const textFilePath = join(audioDir, `narrate_temp_${uniqueId}.txt`);
            const wavFilePath = join(audioDir, `narrate_${uniqueId}.wav`);
            
            writeFileSync(textFilePath, rawParams.text, "utf-8");

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
            } catch {}

            return {
              status: "success",
              message: "Narrazione vocale sintetizzata con successo.",
              audio_file: wavFilePath,
              text: rawParams.text
            };
          } catch (err: any) {
            return { status: "error", message: `Errore durante la sintesi vocale: ${err.message}` };
          }
        }
      }));
    }
  }
} as any);
