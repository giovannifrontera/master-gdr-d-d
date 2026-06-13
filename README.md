# Master GDR D&D

OpenClaw plugin for running tabletop RPG campaigns with an AI Game Master.

The project combines persistent campaign state, dice rolling, structured combat, a browser dashboard, text-to-speech narration, and semantic RAG retrieval over your own rule notes or legally owned manuals.

Although the default language and examples target D&D 5e, the engine is system-agnostic and can be used with Pathfinder, Cyberpunk RED, Call of Cthulhu, Fate, Lady Blackbird, or any ruleset you describe to the agent.

## What It Does

Master GDR D&D installs two OpenClaw plugins that work together:

| Plugin | Role |
| --- | --- |
| `master-dnd-plugin` | Core Game Master engine: campaign state, character sheets, dice, combat, narration, dashboard |
| `wiki-context-plugin` | RAG injector: retrieves relevant wiki/rulebook context before each prompt |

The system keeps three memory layers active during play:

| Layer | Storage | Purpose |
| --- | --- | --- |
| Campaign state | JSON files | Characters, quests, world state, initiative, combat positions |
| Semantic memory | LanceDB vectors | Session logs, indexed rules, wiki extracts |
| Immediate context | Prompt injection | Current state and relevant wiki snippets for the next answer |

## Requirements

- OpenClaw 2026.5.28 or newer
- Node.js 18 or newer
- Python 3.10 or newer for the wiki RAG layer
- Windows PowerShell for the provided one-command installer

Python dependencies can be installed by the plugin tool `rpg_install_dependencies`, or manually:

```bash
pip install -r wiki/requirements.txt
```

## Installation

```powershell
git clone https://github.com/giovannifrontera/master-gdr-d-d.git
cd master-gdr-d-d
.\install.ps1
```

The installer registers both OpenClaw plugins:

```powershell
openclaw plugin add .\master-dnd-plugin
openclaw plugin add .\wiki\plugins\wiki-context-plugin
```

Campaign saves are written to `state/` by default. This directory is intentionally ignored by Git.

## Optional Configuration

All configuration keys are optional. Add overrides to your OpenClaw configuration only when you need custom paths or ports.

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

## Main Tools

All `rpg_*` tools also expose a `dnd_*` alias.

| Tool | Description |
| --- | --- |
| `rpg_start_run` | Start a new campaign |
| `rpg_load_state` | Resume an existing campaign |
| `rpg_list_runs` | List saved campaigns |
| `rpg_save_state` | Save current state manually |
| `rpg_update_state` | Patch selected state fields |
| `rpg_create_character` | Create or update a character sheet |
| `rpg_get_sheet` | Read a character sheet |
| `rpg_roll` | Roll dice such as `1d20+5`, `3d6`, advantage/disadvantage |
| `rpg_combat_start` | Start structured combat with initiative |
| `rpg_combat_damage` | Apply damage or healing |
| `rpg_combat_next_turn` | Advance initiative |
| `rpg_combat_end` | End structured combat |
| `rpg_set_combat_position` | Place a combatant on the dashboard grid |
| `rpg_log_turn` | Persist a turn summary to vector memory |
| `rpg_narrate` | Play narration through Windows TTS |
| `rpg_scan_manuals` | Index PDFs from `manuali/` into the wiki |
| `rpg_wiki_process_raw` | Promote extracted raw wiki files into the searchable index |
| `rpg_check_wiki` | Run wiki/RAG diagnostics |
| `rpg_install_dependencies` | Install Python dependencies |
| `rpg_restore_backup` | Restore an automatic campaign backup |

## Dashboard

After starting a campaign, open:

```text
http://localhost:7332/
```

The dashboard shows:

- Party sheets with HP, stats, inventory and avatars
- Initiative order and an 8x6 combat grid
- Browser chat interface for the Game Master agent

## Repository Layout

```text
master-gdr-d-d/
|-- master-dnd-plugin/              OpenClaw plugin for RPG state and tools
|   |-- src/index.ts                TypeScript source
|   |-- index.js                    Built plugin entry loaded by OpenClaw
|   |-- openclaw.plugin.json        Plugin manifest
|   |-- dashboard.html              Browser dashboard
|   `-- wiki-backend/               Bundled Python helper scripts
|-- wiki/                           Wiki/RAG subsystem
|   |-- scripts/                    Python CLI, server, embedding and PDF tools
|   |-- plugins/wiki-context-plugin OpenClaw context-injection plugin
|   |-- requirements.txt            Python dependencies
|   `-- wiki.config.json            Wiki configuration
|-- install.ps1                     Windows installer
|-- LICENSE                         AGPL-3.0
`-- state/                          Local campaign saves, gitignored
```

## Legal Note

Do not commit copyrighted rulebooks or campaign notes that you cannot redistribute. The repository ignores `manuali/`, `wiki/pdf-inbox/`, generated wiki memory, local state and audio output for this reason.

## License

GNU Affero General Public License v3.0. See [LICENSE](LICENSE).

Copyright (C) 2026 Giovanni Frontera
