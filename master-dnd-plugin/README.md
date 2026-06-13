# master-dnd-plugin

OpenClaw plugin per giocare a GDR (D&D 5e e altri sistemi) con un Game Master IA.  
Gestione stato persistente, dadi, combattimento strutturato, memoria vettoriale RAG, narrazione TTS e dashboard browser in tempo reale.

## Requisiti

- [OpenClaw](https://openclaw.ai) ≥ 2026.5.28
- Python 3.10+ (le dipendenze vengono installate automaticamente al primo avvio)

## Installazione

### 1. Clona il repository

```bash
git clone https://github.com/giovannifrontera/master-gdr-d-d.git
```

### 2. Installa il plugin in OpenClaw

```bash
openclaw plugin add ./master-gdr-d-d/master-dnd-plugin
```

### 3. Configura OpenClaw

Apri `~/.openclaw/openclaw.json` e aggiungi nella sezione `plugins.entries`:

```json
"master-dnd-plugin": {
  "config": {
    "stateDirectory": "/percorso/a/tua/scelta/state",
    "pythonExecutable": "python"
  },
  "enabled": true
}
```

> **Windows**: usa slash forward (`C:/Users/nome/state`) o doppio backslash (`C:\\Users\\nome\\state`).

### 4. Riavvia il gateway

```bash
openclaw gateway restart
```

Al primo avvio il plugin:
- Installa automaticamente le dipendenze Python (`lancedb`, `fastapi`, `sentence-transformers`, ecc.)
- Inizializza il database vettoriale LanceDB
- Avvia il server wiki RAG in background

## Dashboard browser

Apri `http://localhost:7332/` per la dashboard in tempo reale:

- **Party**: schede personaggio con avatar, HP, statistiche, inventario
- **Mappa**: ordine di iniziativa + griglia di combattimento 8×6
- **Chat**: interfaccia diretta con il Game Master IA

## Tool disponibili

| Tool | Descrizione |
|---|---|
| `rpg_start_run` | Inizia una nuova campagna |
| `rpg_load_state` | Riprende una campagna esistente |
| `rpg_list_runs` | Elenca tutte le campagne salvate |
| `rpg_roll` | Tira dadi (1d20+5, 3d6, ecc.) |
| `rpg_create_character` | Crea o aggiorna la scheda personaggio |
| `rpg_combat_start` | Avvia combattimento strutturato con iniziativa |
| `rpg_combat_damage` | Applica danni o cure |
| `rpg_combat_next_turn` | Avanza il turno |
| `rpg_combat_end` | Termina il combattimento |
| `rpg_set_combat_position` | Posiziona token sulla griglia della dashboard |
| `rpg_log_turn` | Salva la sintesi del turno nel database vettoriale |
| `rpg_narrate` | Riproduce narrazione via TTS (Windows) |
| `rpg_scan_manuals` | Indicizza manuali PDF nella wiki RAG |
| `rpg_check_wiki` | Diagnostica completa del sistema wiki RAG |
| `rpg_restore_backup` | Ripristina un backup automatico |
| `rpg_save_state` / `rpg_update_state` | Salva/aggiorna lo stato manualmente |

Tutti i tool hanno un alias `dnd_*` per compatibilità (es. `dnd_roll`).

## Configurazione avanzata

```json
"master-dnd-plugin": {
  "config": {
    "stateDirectory": "/path/state",
    "wikiEnabled": true,
    "wikiDataDirectory": "/path/wiki-data",
    "pythonExecutable": "python",
    "serverPort": 7331,
    "dashboardPort": 7332,
    "k": 3,
    "maxChars": 600,
    "debug": false
  }
}
```

## Sistemi di gioco supportati

Il plugin è system-agnostic. Funziona con qualsiasi GDR: D&D 5e, Pathfinder, Cyberpunk, Call of Cthulhu, Fate, Lady Blackbird, e qualsiasi sistema descritto al master IA.

## Licenza

AGPL-3.0. Vedi `../LICENSE`.
