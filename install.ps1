# install.ps1 — Registra master-dnd-plugin in OpenClaw
$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$setupScript = Join-Path $projectRoot "master-dnd-plugin\wiki-backend\scripts\setup_openclaw.py"

Write-Host ""
Write-Host "=== Installazione plugin Master D&D ===" -ForegroundColor Cyan
Write-Host ""

# 'openclaw plugin add' NON popola plugins.load.paths, quindi OpenClaw non carica
# il plugin. setup_openclaw.py scrive load.paths + allow + entries in openclaw.json
# in modo idempotente e atomico.

# Trova un interprete Python
$python = $null
foreach ($cmd in @("py", "python", "python3")) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) { $python = $cmd; break }
}

if ($python) {
    Write-Host "Registrazione automatica via setup_openclaw.py ($python)..." -ForegroundColor Yellow
    & $python $setupScript
    if ($?) {
        Write-Host ""
        Write-Host "=== Fatto. Riavvia il gateway: openclaw gateway restart ===" -ForegroundColor Cyan
        Write-Host ""
        exit 0
    }
    Write-Host "Registrazione automatica fallita — passo alle istruzioni manuali." -ForegroundColor DarkYellow
}
else {
    Write-Host "Python non trovato nel PATH — istruzioni manuali:" -ForegroundColor DarkYellow
}

# Fallback manuale: stampa la config pronta da incollare in ~/.openclaw/openclaw.json
$masterFwd = (Join-Path $projectRoot "master-dnd-plugin") -replace '\\', '/'
$stateFwd  = (Join-Path $projectRoot "state") -replace '\\', '/'

Write-Host ""
Write-Host "Apri ~/.openclaw/openclaw.json e fondi queste voci nella sezione \"plugins\":" -ForegroundColor White
Write-Host ""

$snippet = @"
{
  "plugins": {
    "load": { "paths": ["$masterFwd"] },
    "allow": ["master-dnd-plugin"],
    "entries": {
      "master-dnd-plugin": {
        "enabled": true,
        "config": { "stateDirectory": "$stateFwd", "pythonExecutable": "python", "dashboardPort": 47332 }
      }
    }
  }
}
"@

Write-Host $snippet -ForegroundColor Gray
Write-Host ""
Write-Host "Se hai gia' altri plugin, AGGIUNGI le voci agli array/oggetti esistenti (non sovrascrivere)." -ForegroundColor DarkYellow
Write-Host ""
Write-Host "Poi riavvia il gateway:  openclaw gateway restart" -ForegroundColor Cyan
Write-Host ""
