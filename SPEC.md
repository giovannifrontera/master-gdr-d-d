# SPEC — Plugin OpenClaw: Master Bot D&D

## Visione
Un plugin per OpenClaw che trasforma un agente in **Game Master automatico** per sessioni di D&D 5e (e derivate). Memoria persistente dei PG, della run, e delle regole.

## Problema che risolve
I bot GDR esistenti dimenticano:
- I dati dei personaggi dopo poche interazioni
- Lo storico della run (cosa è successo 10 turni fa?)
- Le regole applicate (vantaggi, svantaggi, condizioni attive)

**Soluzione:** Tre livelli di memoria come Virginia:
1. **State JSON** — PG, mondo, quest — sempre disponibile
2. **Memoria vettoriale** — storico run, chunk rilevanti
3. **Contesto immediato** — ultimi N scambi

## Architettura

```
Giocatore ←→ Telegram ←→ OpenClaw Gateway ←→ Plugin Master
                                                    │
                                            ┌───────┼───────┐
                                            │       │       │
                                       State DB   LanceDB  Wiki D&D
                                       (JSON)   (vettoriale) (regole)
```

## Componenti

### 1. State Manager (`state/`)
Salva e carica lo stato persistente della run.

```json
{
  "run_id": "run-20260601-abc123",
  "titolo": "La Foresta di Mirwood",
  "data_inizio": "2026-06-01T16:00:00Z",
  "turno": 12,
  "personaggi": {
    "eldrin": {
      "giocatore": "@Mario",
      "razza": "Elfo Alto",
      "classe": "Mago",
      "livello": 3,
      "stats": { "for": 8, "des": 14, "cos": 12, "int": 16, "sag": 12, "car": 10 },
      "hp": { "max": 18, "correnti": 18 },
      "ca": 12,
      "inventario": ["Bastone Magico", "Pergamena di Fulmine", "Razioni (5)"],
      "quest_attive": ["Trovare il Grimorio Perduto"]
    }
  },
  "mondo": {
    "locazione": "Foresta di Mirwood — Sentiero Nord",
    "tempo": "Notte, Luna Piena",
    "npcs_incontrati": [
      { "nome": "Elara la Barda", "stato": "amichevole", "info": "Canta canzoni antiche" }
    ],
    "stato_trame": {
      "grimorio_perduto": "hanno trovato l'ingresso del sotterraneo"
    }
  }
}
```

### 2. Memoria della Run (`run-memory/`)
LanceDB con embedding bge-m3. Ogni azione importante viene salvata come chunk:
- "Eldrin ha aperto lo scrigno con Investigare CD 15 — successo. Ha trovato una Pergamena di Fulmine"
- "Il gruppo ha parlato con Elara la Barda — ha rivelato che il grimorio è nel Tempio Sommerso"

Quando il master deve rispondere, cerca chunk semanticamente rilevanti.

### 3. Regole D&D (`rules/`)
Wiki embeddata con le regole essenziali:
- Azioni in combattimento
- Tiri salvezza
- Classi, razze, talenti
- Incantesimi (top 100+)
- Mostri (CR 0-10 per iniziare)

### 4. Dado Virtuale (`roll/`)
Wrapper per tiri di dado:
- `/r 1d20` → risultato
- `/r 1d20+5` → con modificatore
- `/r vantaggio 1d20` → tira due, prende il maggiore
- `/r 3d6` → dadi multipli

### 5. Comandi / Azioni
- `/start_run` — inizia nuova run
- `/load_run <id>` — carica run esistente
- `/crea_pg` — wizard creazione personaggio
- `/scheda` — mostra scheda PG
- `/azione <descrizione>` — il PG compie un'azione
- `/r <dadi>` — tiro di dado manuale
- `/stato` — mostra stato del mondo
- `/salva` — salva manualmente

## Flusso di Gioco

```
Giocatore: "Indago lo scrigno. Investigare: 1d20+5"

Master Bot:
1. Riceve messaggio
2. Aggiorna turno in state JSON
3. Cerca in memoria: "scrigno, investigare, trappole"
4. Trova chunk: "NA" (non ancora indagato)
5. Calcola: tiro dado → risultato
6. Determina esito con regole D&D
7. Risponde con descrizione narrativa
8. Salva azione nella memoria vettoriale
9. Aggiorna stato (se qualcosa cambia)
```

## Integrazione con OpenClaw

Il plugin si installa come uno skill:
```
openclaw plugin install master-d&d
```

Config:
```yaml
# openclaw.yaml o skill config
plugins:
  master-dnd:
    enabled: true
    dashboardPort: 47332
    wikiDataDir: "state/wiki-data"
    run_memory_path: "run-memory/"
    max_players: 6
    default_level: 1
```

Il plugin espone:
- **Tool**: `roll_dice`, `lookup_rule`, `get_sheet`, `save_state`, `load_state`
- **Eventi**: `on_player_action`, `on_turn_end`, `on_run_save`
- **Prompt injection**: contesto della run negli ultimi N messaggi

## MVP (Minimo Funzionante)

1. ✅ State JSON persistente (PG + mondo)
2. ✅ Tiro di dado (/r 1d20)
3. ✅ Azioni base: esplorare, interagire, combattere
4. ✅ Memoria vettoriale delle azioni passate
5. ✅ Wiki con mostri base e magie

## Roadmap

| Fase | Cosa |
|------|------|
| **1** | State JSON + roll tool + comandi base |
| **2** | Memoria vettoriale per storico run |
| **3** | Wiki D&D con regole, mostri, magie |
| **4** | Wizard creazione PG |
| **5** | Combattimento strutturato (turni, iniziativa) |
| **6** | Salvataggio automatico + backup |
| **7** | Integrazione voce (narrazione TTS) |
| **8** | Multi-run parallele |

## Note per lo Sviluppo

- **Plugin Language:** JavaScript/Node.js (nativo OpenClaw)
- **Memoria:** LanceDB (stessa del mio sistema — già funzionante)
- **Dadi:** Libreria JS `dice-roller` (leggera, testata)
- **Regole:** Embeddate da SRD 5.1 (Open Game License) — legale
- **Narrazione:** Il master è il LLM sottostante (DeepSeek/Gemini/Claude) — il plugin fornisce solo il contesto e i tool
