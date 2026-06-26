# OpenClaw Sandbox - master-dnd-plugin

Documento operativo per installare e verificare `master-dnd-plugin` nella sandbox OpenClaw senza link alla repo.

## Stato desiderato

Il plugin deve essere installato come estensione gestita:

```text
C:\openclaw-sandbox\home\.openclaw\extensions\master-dnd-plugin
```

Non deve essere caricato da:

```text
C:\openclaw-sandbox\home\.openclaw\workspace\master-gdr-d-d\master-dnd-plugin
```

`plugins.load.paths` non deve contenere il path del plugin. Quel meccanismo carica una cartella di sviluppo, non installa il plugin.

## Installazione plugin

Da PowerShell/cmd:

```bat
set OPENCLAW_HOME=C:\openclaw-sandbox\home
set OPENCLAW_NO_AUTO_UPDATE=1
C:\openclaw-sandbox\node_modules\.bin\openclaw.cmd plugins install C:\Users\Giovanni\Documents\workspace\progetto-master-gdr-d&d\master-dnd-plugin --force
C:\openclaw-sandbox\node_modules\.bin\openclaw.cmd plugins registry --refresh
```

Verifica:

```bat
set OPENCLAW_HOME=C:\openclaw-sandbox\home
C:\openclaw-sandbox\node_modules\.bin\openclaw.cmd plugins inspect master-dnd-plugin
```

Output atteso:

```text
Source: $OPENCLAW_HOME\.openclaw\extensions\master-dnd-plugin\index.js
Install path: $OPENCLAW_HOME\.openclaw\extensions\master-dnd-plugin
```

## Installazione skill

Le skill del plugin sono in:

```text
master-dnd-plugin\wiki-backend\skills
```

OpenClaw installa skill locali da directory con `SKILL.md`. Preparare tre directory:

```text
rpg-gm\SKILL.md      <- copia di rpg-gm.md
wiki-core\SKILL.md   <- copia di wiki-core.md
wiki-setup\SKILL.md  <- copia di wiki-setup.md
```

Installare:

```bat
set OPENCLAW_HOME=C:\openclaw-sandbox\home
C:\openclaw-sandbox\node_modules\.bin\openclaw.cmd skills install C:\openclaw-sandbox\skill-install-staging\rpg-gm --global --force
C:\openclaw-sandbox\node_modules\.bin\openclaw.cmd skills install C:\openclaw-sandbox\skill-install-staging\wiki-core --global --force
C:\openclaw-sandbox\node_modules\.bin\openclaw.cmd skills install C:\openclaw-sandbox\skill-install-staging\wiki-setup --global --force
```

Output atteso:

```text
Installed rpg-gm
Installed wiki-core
Installed wiki-setup
```

Verifica:

```bat
C:\openclaw-sandbox\node_modules\.bin\openclaw.cmd skills list
```

Devono comparire come `openclaw-managed` e `ready`:

- `rpg-gm`
- `wiki-core`
- `wiki-setup`

## Config sandbox

Nel file:

```text
C:\openclaw-sandbox\home\.openclaw\openclaw.json
```

la sezione plugin deve contenere `entries.master-dnd-plugin`, ma non il vecchio `plugins.load.paths` verso la repo/workspace.

Esempio:

```json
"master-dnd-plugin": {
  "enabled": true,
  "config": {
    "stateDirectory": "C:/openclaw-sandbox/home/.openclaw/workspace/master-gdr-d-d/state",
    "pythonExecutable": "py",
    "minRelevance": 0.2
  }
}
```

## Dashboard

URL:

```text
http://localhost:47332/
```

La dashboard e' servita dal plugin quando il gateway carica `master-dnd-plugin`.

Se `/api/state` risponde:

```json
{"error":"no active run"}
```

non c'e' una run attiva. Avvia o carica una run dal TUI con:

```text
rpg_start_run
rpg_load_state
```

## Funzioni nuove

- `rpg_save_image` / `dnd_save_image`
- asset per-run serviti da `/assets/<file>`
- immagine clou di scena
- lightbox immagini
- scheda completa del personaggio selezionato
- grafo relazioni
- chat comprimibile
- proxy WebSocket dashboard basato su `ws` Node

## Verifiche tecniche

Sulla copia installata:

```bat
node --check C:\openclaw-sandbox\home\.openclaw\extensions\master-dnd-plugin\index.js
node --test C:\openclaw-sandbox\home\.openclaw\extensions\master-dnd-plugin\test\media.test.js
```

Atteso:

```text
7 tests pass
```

## Troubleshooting

### Dashboard vecchia

Eseguire:

```bat
openclaw plugins inspect master-dnd-plugin
```

Se `Source` punta al workspace o alla repo, il plugin non e' installato correttamente. Reinstallare con `openclaw plugins install ... --force` e rimuovere `plugins.load.paths`.

### `WS proxy error`

Il gateway in esecuzione puo' avere ancora il vecchio codice in memoria. Riavviare il gateway sandbox.

La fix corretta nel plugin e': usare il pacchetto `ws` di Node per la connessione interna al gateway, non `globalThis.WebSocket`.

### Skill non trovate

Errore tipico:

```text
ENOENT ... workspace\skills\rpg-gm.md
ENOENT ... workspace\skills\wiki-core.md
```

Installare le skill come `openclaw-managed` con `openclaw skills install`. Se il prompt continua a leggere `skills/*.md` dal workspace, mantenere anche una copia in:

```text
C:\openclaw-sandbox\home\.openclaw\workspace\skills
```

La soluzione preferita resta l'installazione gestita.

## Riavvio

Dopo ogni installazione o update:

```bat
openclaw gateway restart
```

Se il gateway e' stato avviato con il `.bat`, chiudere la finestra gateway e rilanciare il `.bat`.
