# install.ps1 — Installa i plugin OpenClaw del progetto Master D&D
$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$masterPlugin = Join-Path $projectRoot "master-dnd-plugin"
$wikiPlugin   = Join-Path $projectRoot "wiki\plugins\wiki-context-plugin"

Write-Host ""
Write-Host "=== Installazione plugin Master D&D ===" -ForegroundColor Cyan
Write-Host ""

# Nota: 'openclaw plugin add' NON registra correttamente questi plugin (non popola
# plugins.load.paths). La registrazione va fatta a mano in ~/.openclaw/openclaw.json.
# Questo script stampa la configurazione pronta da incollare, con i percorsi assoluti corretti.

$masterFwd = $masterPlugin -replace '\\', '/'
$wikiFwd   = $wikiPlugin -replace '\\', '/'
$stateFwd  = (Join-Path $projectRoot "state") -replace '\\', '/'
$wikiScript = (Join-Path $projectRoot "wiki\scripts\wiki_context.py") -replace '\\', '/'

Write-Host "Registrazione MANUALE richiesta." -ForegroundColor Yellow
Write-Host "Apri ~/.openclaw/openclaw.json e fondi le seguenti voci nella sezione \"plugins\":" -ForegroundColor White
Write-Host ""

$snippet = @"
{
  "plugins": {
    "load": {
      "paths": [
        "$masterFwd",
        "$wikiFwd"
      ]
    },
    "allow": ["master-dnd-plugin", "wiki-context-plugin"],
    "entries": {
      "master-dnd-plugin": {
        "enabled": true,
        "config": { "stateDirectory": "$stateFwd", "pythonExecutable": "python" }
      },
      "wiki-context-plugin": {
        "enabled": true,
        "config": { "workspace": "$wikiFwd", "wikiContextScript": "$wikiScript", "pythonExecutable": "py" }
      }
    }
  }
}
"@

Write-Host $snippet -ForegroundColor Gray
Write-Host ""
Write-Host "Se hai gia' altri plugin, AGGIUNGI le voci agli array/oggetti esistenti (non sovrascrivere)." -ForegroundColor DarkYellow
Write-Host ""
Write-Host "Poi riavvia il gateway:" -ForegroundColor White
Write-Host "  openclaw gateway restart" -ForegroundColor Cyan
Write-Host ""
