# install.ps1 — Installa i plugin OpenClaw del progetto Master D&D
$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$masterPlugin = Join-Path $projectRoot "master-dnd-plugin"
$wikiPlugin   = Join-Path $projectRoot "wiki\plugins\wiki-context-plugin"

Write-Host ""
Write-Host "=== Installazione plugin Master D&D ===" -ForegroundColor Cyan
Write-Host ""

if (-not (Get-Command "openclaw" -ErrorAction SilentlyContinue)) {
    Write-Error "Errore: 'openclaw' non trovato nel PATH. Installa OpenClaw prima di procedere."
    exit 1
}

Write-Host "Installazione master-dnd-plugin..." -ForegroundColor Yellow
openclaw plugin add $masterPlugin
if (-not $?) { Write-Error "Installazione master-dnd-plugin fallita."; exit 1 }
Write-Host "  master-dnd-plugin installato." -ForegroundColor Green

Write-Host "Installazione wiki-context-plugin..." -ForegroundColor Yellow
openclaw plugin add $wikiPlugin
if (-not $?) { Write-Error "Installazione wiki-context-plugin fallita."; exit 1 }
Write-Host "  wiki-context-plugin installato." -ForegroundColor Green

Write-Host ""
Write-Host "=== Installazione completata ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "File di stato salvati in: $projectRoot\state" -ForegroundColor White
Write-Host "Script wiki in:           $projectRoot\wiki\scripts\wiki_context.py" -ForegroundColor White
Write-Host ""
Write-Host "Per usare percorsi personalizzati, aggiungi in ~/.openclaw/openclaw.json:" -ForegroundColor Gray
Write-Host '  "master-dnd-plugin":   { "config": { "stateDirectory": "C:/percorso/custom/state" } }' -ForegroundColor Gray
Write-Host '  "wiki-context-plugin": { "config": { "workspace": "C:/percorso/wiki", "wikiContextScript": "C:/percorso/wiki/scripts/wiki_context.py" } }' -ForegroundColor Gray
Write-Host ""
