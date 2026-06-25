#!/usr/bin/env python3
"""
setup_openclaw.py — registra master-dnd-plugin nel file di configurazione di OpenClaw.

Uso:
    py wiki-backend/scripts/setup_openclaw.py
    py wiki-backend/scripts/setup_openclaw.py --config /percorso/a/openclaw.json
    py wiki-backend/scripts/setup_openclaw.py --dry-run

Perche' serve:
    'openclaw plugin add' NON popola plugins.load.paths, quindi OpenClaw non
    carica il plugin. Perche' un plugin venga caricato servono TRE cose nella
    sezione "plugins" di openclaw.json:
      - load.paths : la cartella del plugin (discovery)
      - allow      : l'id del plugin (whitelist)
      - entries    : { "enabled": true, "config": {...} }

    Questo script le scrive tutte e tre, in modo idempotente (rieseguibile senza
    duplicare) e atomico (file temporaneo + rename).
"""

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

PLUGIN_ID = "master-dnd-plugin"

# La cartella del plugin e' due livelli sopra questo script:
#   master-dnd-plugin/wiki-backend/scripts/setup_openclaw.py
PLUGIN_DIR = Path(__file__).resolve().parent.parent.parent
DEFAULT_STATE_DIR = PLUGIN_DIR.parent / "state"

# Il file di config di OpenClaw si chiama openclaw.json (non config.json).
CANDIDATE_PATHS = [
    Path(os.environ["OPENCLAW_HOME"]) / ".openclaw" / "openclaw.json"
    if os.environ.get("OPENCLAW_HOME") else None,
    Path.home() / ".openclaw" / "openclaw.json",
    Path.home() / ".config" / "openclaw" / "openclaw.json",
    Path(os.environ.get("APPDATA", "")) / "openclaw" / "openclaw.json",
    Path(os.environ.get("LOCALAPPDATA", "")) / "openclaw" / "openclaw.json",
    # fallback storici
    Path.home() / ".openclaw" / "config.json",
    Path.cwd() / "openclaw.json",
]


def find_openclaw_config():
    for p in CANDIDATE_PATHS:
        if p and p.exists():
            return p
    return None


def detect_python() -> str:
    return "py" if os.name == "nt" else "python3"


def fwd(path) -> str:
    """Percorso con slash forward — su Windows i backslash rompono il JSON."""
    return str(path).replace("\\", "/")


def register_plugin(config: dict, plugin_id: str, plugin_dir: str, entry_config: dict) -> bool:
    """Inserisce plugin_id in load.paths, allow ed entries. Idempotente.

    Ritorna True se ha modificato qualcosa, False se era gia' tutto a posto.
    """
    plugins = config.setdefault("plugins", {})
    changed = False

    paths = plugins.setdefault("load", {}).setdefault("paths", [])
    if plugin_dir not in paths:
        paths.append(plugin_dir)
        changed = True

    allow = plugins.setdefault("allow", [])
    if plugin_id not in allow:
        allow.append(plugin_id)
        changed = True

    entries = plugins.setdefault("entries", {})
    current = entries.get(plugin_id) if isinstance(entries.get(plugin_id), dict) else {}
    current_config = current.get("config") if isinstance(current.get("config"), dict) else {}
    desired_config = {**current_config, **entry_config}
    desired = {**current, "enabled": True, "config": desired_config}
    if entries.get(plugin_id) != desired:
        entries[plugin_id] = desired
        changed = True

    return changed


def main() -> None:
    parser = argparse.ArgumentParser(description="Registra master-dnd-plugin in OpenClaw")
    parser.add_argument("--config", help="Path al file openclaw.json (default: auto-rilevato)")
    parser.add_argument("--python", default=detect_python(),
                        help=f"Eseguibile Python per il plugin (default: {detect_python()})")
    parser.add_argument("--state-dir", default=str(DEFAULT_STATE_DIR),
                        help=f"Cartella di stato (default: {DEFAULT_STATE_DIR})")
    parser.add_argument("--dry-run", action="store_true",
                        help="Stampa il risultato senza scrivere")
    parser.add_argument("--self-test", action="store_true",
                        help="Esegue il test interno di register_plugin ed esce")
    args = parser.parse_args()

    if args.self_test:
        _self_test()
        return

    if not PLUGIN_DIR.exists():
        print(f"ERRORE: cartella plugin non trovata: {PLUGIN_DIR}", file=sys.stderr)
        sys.exit(1)

    # Individua il config di OpenClaw
    if args.config:
        config_path = Path(args.config).resolve()
        if not config_path.exists():
            print(f"ERRORE: config non trovato: {config_path}", file=sys.stderr)
            sys.exit(1)
    else:
        config_path = find_openclaw_config()
        if config_path is None:
            print("ERRORE: impossibile auto-rilevare openclaw.json. Cercato in:", file=sys.stderr)
            for p in CANDIDATE_PATHS:
                print(f"  {p}", file=sys.stderr)
            print("\nPassa --config /percorso/a/openclaw.json esplicitamente.", file=sys.stderr)
            sys.exit(1)

    # Carica il config esistente
    try:
        with open(config_path, encoding="utf-8-sig") as f:
            config = json.load(f)
    except json.JSONDecodeError as e:
        print(f"ERRORE: {config_path} non e' JSON valido: {e}", file=sys.stderr)
        sys.exit(1)

    entry_config = {
        "stateDirectory": fwd(Path(args.state_dir).resolve()),
        "pythonExecutable": args.python,
    }
    changed = register_plugin(config, PLUGIN_ID, fwd(PLUGIN_DIR), entry_config)

    if not changed:
        print(f"{PLUGIN_ID} gia' registrato in {config_path} — niente da fare.")
        return

    if args.dry_run:
        print(f"DRY RUN — scriverei in: {config_path}\n")
        print(json.dumps(config, indent=2, ensure_ascii=False))
        return

    # Scrittura atomica (file temporaneo + rename)
    fd, tmp_path = tempfile.mkstemp(dir=config_path.parent, prefix=".openclaw.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp_path, config_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

    print(f"{PLUGIN_ID} registrato in {config_path}")
    print(f"  plugin dir : {fwd(PLUGIN_DIR)}")
    print(f"  state dir  : {entry_config['stateDirectory']}")
    print(f"  python     : {args.python}")
    print()
    print("Riavvia il gateway per attivarlo:  openclaw gateway restart")


def _self_test() -> None:
    # Config vuoto: deve aggiungere tutte e tre le sezioni.
    cfg = {}
    assert register_plugin(cfg, "p", "/dir", {"k": 1}) is True
    assert cfg["plugins"]["load"]["paths"] == ["/dir"]
    assert cfg["plugins"]["allow"] == ["p"]
    assert cfg["plugins"]["entries"]["p"] == {"enabled": True, "config": {"k": 1}}
    # Riesecuzione identica: idempotente, nessuna modifica e nessun duplicato.
    assert register_plugin(cfg, "p", "/dir", {"k": 1}) is False
    assert cfg["plugins"]["load"]["paths"] == ["/dir"]
    assert cfg["plugins"]["allow"] == ["p"]
    # Plugin gia' esistenti preservati; cambio di config rilevato.
    cfg2 = {"plugins": {"load": {"paths": ["/other"]}, "allow": ["other"],
                        "entries": {"other": {"enabled": True, "config": {}}}}}
    assert register_plugin(cfg2, "p", "/dir", {"k": 2}) is True
    assert cfg2["plugins"]["load"]["paths"] == ["/other", "/dir"]
    assert set(cfg2["plugins"]["allow"]) == {"other", "p"}
    assert cfg2["plugins"]["entries"]["other"] == {"enabled": True, "config": {}}
    cfg3 = {"plugins": {"entries": {"p": {"enabled": False, "config": {"debug": True, "k": 1}}}}}
    assert register_plugin(cfg3, "p", "/dir", {"k": 2}) is True
    assert cfg3["plugins"]["entries"]["p"] == {"enabled": True, "config": {"debug": True, "k": 2}}
    print("self-test OK")


if __name__ == "__main__":
    main()
