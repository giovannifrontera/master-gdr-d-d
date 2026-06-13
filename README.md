# master-gdr-d&d

**D&D 5e Game Master plugin for [OpenClaw](https://openclaw.ai)**

Turn any OpenClaw agent into a fully-featured D&D 5e Game Master with persistent memory, structured combat, dice rolling, a real-time browser dashboard, and semantic RAG retrieval over your rulebooks.

---

## What it is

Two OpenClaw plugins that work together:

| Plugin | Role |
|---|---|
| `master-dnd-plugin` | Core GM engine — state, dice, combat, narration |
| `wiki-context-plugin` | RAG injector — injects relevant wiki/rulebook pages before every prompt |

### Three layers of memory

| Layer | Storage | Persistence |
|---|---|---|
| **Session state** | JSON files — characters, quests, world, initiative | Across sessions |
| **Semantic memory** | LanceDB vectors — session logs, indexed rules, wiki extracts | Permanent, semantic search |
| **Immediate context** | Injected `<wiki-context>` block | Per-prompt |

---

## Requirements

- [OpenClaw](https://openclaw.ai) ≥ 2026.5.28
- Node.js ≥ 18
- Python ≥ 3.10 (for the wiki RAG layer)

Python dependencies are installed automatically on first run via `rpg_install_dependencies`, or manually:

```bash
pip install -r wiki/requirements.txt
```

---

## Installation

### Windows (recommended)

```powershell
git clone https://github.com/giovannifrontera/master-gdr-d-d.git
cd master-gdr-d-d
.\install.ps1
```

`install.ps1` runs `openclaw plugin add` for both plugins and shows where state files are stored.

### Manual

```bash
openclaw plugin add ./master-dnd-plugin
openclaw plugin add ./wiki/plugins/wiki-context-plugin
```

Both plugins work out-of-the-box with zero additional configuration. State files land in `./state/`, wiki scripts are resolved relative to the plugin root.

---

## Optional configuration

Add entries to `~/.openclaw/openclaw.json` to override default paths:

```json
{
  "plugins": {
    "entries": {
      "master-dnd-plugin": {
        "config": {
          "stateDirectory": "C:/my-campaigns/state",
          "pythonExecutable": "python",
          "serverPort": 7331,
          "dashboardPort": 7332,
          "wikiEnabled": true,
          "debug": false
        }
      },
      "wiki-context-plugin": {
        "config": {
          "workspace": "C:/my-campaigns/wiki",
          "wikiContextScript": "C:/my-campaigns/wiki/scripts/wiki_context.py",
          "k": 3,
          "maxChars": 600,
          "timeoutMs": 15000
        }
      }
    }
  }
}
```

All config keys are optional — omitting them uses relative defaults.

---

## Tools

All tools have a `dnd_*` alias (e.g. `dnd_roll` = `rpg_roll`).

### Session management

| Tool | Description |
|---|---|
| `rpg_start_run` | Start a new campaign |
| `rpg_load_state` | Resume an existing campaign |
| `rpg_list_runs` | List all saved campaigns |
| `rpg_save_state` | Save current state manually |
| `rpg_update_state` | Patch specific fields of the state |
| `rpg_restore_backup` | Restore an automatic backup |

### Characters

| Tool | Description |
|---|---|
| `rpg_create_character` | Create or update a character sheet |
| `rpg_get_sheet` | Read a character sheet |

### Dice and combat

| Tool | Description |
|---|---|
| `rpg_roll` | Roll dice — `1d20+5`, `3d6`, advantage, etc. |
| `rpg_combat_start` | Start structured combat with initiative order |
| `rpg_combat_damage` | Apply damage or healing |
| `rpg_combat_next_turn` | Advance to the next combatant |
| `rpg_combat_end` | End combat |
| `rpg_set_combat_position` | Place a token on the dashboard grid |

### Narrative and memory

| Tool | Description |
|---|---|
| `rpg_log_turn` | Persist turn summary to vector memory |
| `rpg_narrate` | Text-to-speech narration (Windows) |

### Wiki RAG

| Tool | Description |
|---|---|
| `rpg_install_dependencies` | Install Python dependencies |
| `rpg_scan_manuals` | Index PDF rulebooks into the wiki |
| `rpg_check_wiki` | Full diagnostic of the wiki RAG system |
| `rpg_wiki_process_raw` | Promote raw/ files to the searchable index |

---

## Dashboard

Open `http://localhost:7332/` after starting a session:

- **Party** — character sheets with avatar, HP, stats, inventory
- **Map** — initiative order + 8×6 combat grid with token positions
- **Chat** — direct interface to the GM agent

---

## Architecture

```
progetto-master-gdr-d&d/
├── master-dnd-plugin/        ← OpenClaw plugin (Node.js)
│   ├── index.js              ← plugin entry point (loaded by OpenClaw)
│   ├── openclaw.plugin.json  ← plugin manifest
│   ├── src/                  ← TypeScript source
│   ├── wiki-backend/         ← Python helpers (TTS, combat log, etc.)
│   └── dashboard.html        ← browser dashboard
│
├── wiki/                     ← Wiki RAG subsystem
│   ├── plugins/wiki-context-plugin/  ← OpenClaw plugin (Node.js)
│   │   ├── index.js          ← plugin entry point
│   │   ├── src/              ← TypeScript source
│   │   └── openclaw.plugin.json
│   ├── scripts/              ← Python scripts (wiki_context.py, wiki.py, …)
│   ├── requirements.txt      ← Python dependencies
│   └── wiki.config.json      ← wiki indexer configuration
│
├── state/                    ← (gitignored) game saves and session state
├── install.ps1               ← one-command installer (Windows)
└── LICENSE                   ← AGPL-3.0
```

The `wiki-context-plugin` hooks into `before_prompt_build`: it queries the running wiki server (or falls back to a subprocess) and prepends a `<wiki-context>` block with the most semantically relevant rules/notes for the current user prompt.

---

## System agnostic

The plugin is system-agnostic. Works with any TTRPG: D&D 5e, Pathfinder 2e, Cyberpunk RED, Call of Cthulhu, Fate, or any system you describe to the agent.

---

## License

GNU Affero General Public License v3.0 — see [LICENSE](LICENSE).

Copyright (C) 2026 Giovanni Frontera

---

*Plugin per [OpenClaw](https://openclaw.ai) — il gateway AI modulare e open-source.*
