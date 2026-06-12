# Self-Containment Fix — progetto-master-gdr-d&d

**Data analisi:** 2026-06-12  
**Stato:** da fare

Il plugin funziona sulla macchina di sviluppo ma NON è installabile su una configurazione OpenClaw vergine. Tre problemi da risolvere, in ordine di priorità.

---

## Problema 1 — Percorsi assoluti nella config OpenClaw (CRITICO)

### Dove si trova il problema

In `~/.openclaw/openclaw.json`, la sezione `plugins.entries` contiene percorsi assoluti hardcoded:

```json
"master-dnd-plugin": {
  "config": {
    "stateDirectory": "C:/Users/Giovanni/Documenti/workspace/progetto-master-gdr-d&d/state"
  }
},
"wiki-context-plugin": {
  "config": {
    "wikiContextScript": "C:/Users/Giovanni/Documenti/workspace/progetto-master-gdr-d&d/wiki/scripts/wiki_context.py",
    "workspace": "C:/Users/Giovanni/Documenti/workspace/progetto-master-gdr-d&d/wiki",
    "pythonExecutable": "python",
    "k": 3,
    "timeoutMs": 15000
  }
}
```

### Cosa fare

In `master-dnd-plugin/index.js`, dove viene letto `stateDirectory` dalla config, aggiungere un fallback relativo alla root del plugin:

```javascript
// Prima: usa il valore dalla config utente o lancia errore
const stateDir = config.stateDirectory;

// Dopo: se non configurato, usa ./state/ relativo alla root del plugin
const pluginRoot = dirname(fileURLToPath(import.meta.url));
const stateDir = config.stateDirectory ?? join(pluginRoot, '..', 'state');
```

Stesso approccio per `wiki-context-plugin` — `wikiContextScript` e `workspace` dovrebbero avere default relativi alla root del plugin wiki.

### Risultato atteso

Il plugin funziona out-of-the-box senza dover toccare `openclaw.json`. La config rimane opzionale per chi vuole sovrascrivere i path.

---

## Problema 2 — Lettura diretta di `~/.openclaw/openclaw.json` a runtime (ALTO)

### Dove si trova il problema

`master-dnd-plugin/index.js` riga ~571:

```javascript
const ocCfg = JSON.parse(readFileSync(join(homedir(), ".openclaw", "openclaw.json"), "utf-8"));
```

Il plugin legge direttamente il file di config interno di OpenClaw per estrarre il token del gateway WebSocket e la porta.

### Cosa fare

Verificare se OpenClaw SDK espone già il token/porta tramite l'API ufficiale (es. `api.gateway.token`, `api.gateway.port`, o simili). Se sì, usare l'API invece del file diretto.

Se l'SDK non espone questi dati, aprire un'issue o documentare esplicitamente che questa lettura diretta è un workaround intenzionale, e aggiungere gestione dell'errore se il file non esiste o ha formato diverso.

### File da investigare

- `master-dnd-plugin/index.js` — cercare tutte le occorrenze di `openclaw.json`
- Documentazione OpenClaw SDK — verificare se esiste un'API pubblica per il gateway

---

## Problema 3 — Registrazione manuale in `installs.json` (MEDIO)

### Dove si trova il problema

In `~/.openclaw/plugins/installs.json`, i plugin sono registrati come source `"path"` con percorsi assoluti. Questo significa che il plugin non è installabile con `openclaw plugin add <path>` in modo automatico.

### Cosa fare

Creare uno script PowerShell `install.ps1` (Windows) che:

1. Risolve il percorso assoluto della cartella del plugin
2. Esegue `openclaw plugin add <percorso>` per entrambi i plugin
3. (Opzionale) Mostra un messaggio con le istruzioni per configurare `stateDirectory` se si vuole un path personalizzato

```powershell
# install.ps1
$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$masterPlugin = Join-Path $pluginRoot "master-dnd-plugin"
$wikiPlugin = Join-Path $pluginRoot "wiki\plugins\wiki-context-plugin"

Write-Host "Installazione master-dnd-plugin..."
openclaw plugin add $masterPlugin

Write-Host "Installazione wiki-context-plugin..."
openclaw plugin add $wikiPlugin

Write-Host "Installazione completata."
Write-Host "I file di stato verranno salvati in: $pluginRoot\state"
```

---

## Piano di lavoro

| # | Azione | File da modificare | Priorità |
|---|--------|-------------------|----------|
| 1 | Aggiungere default relativi per `stateDirectory` | `master-dnd-plugin/index.js` | CRITICA |
| 2 | Aggiungere default relativi per `wikiContextScript` e `workspace` | `wiki/plugins/wiki-context-plugin/index.js` | CRITICA |
| 3 | Investigare API SDK per gateway token/porta | `master-dnd-plugin/index.js` | ALTA |
| 4 | Creare `install.ps1` | root del progetto | MEDIA |
| 5 | Testare installazione su configurazione OpenClaw vergine | — | VERIFICA |

---

## Come riprendere

Alla prossima sessione:

1. Invocare `superpowers:subagent-driven-development`
2. Leggere questo file
3. Partire dal Problema 1 — è il blocco principale per la portabilità
4. Verificare leggendo `master-dnd-plugin/index.js` come viene usato `config.stateDirectory`
5. Fare lo stesso per il wiki plugin
