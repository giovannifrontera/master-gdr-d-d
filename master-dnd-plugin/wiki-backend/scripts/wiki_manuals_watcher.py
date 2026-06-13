#!/usr/bin/env python3
"""
wiki_manuals_watcher.py — Automatic RPG rulebooks indexing watcher.
Scans the 'manuali/' directory, detects system based on subfolders,
extracts text and indexes into LanceDB. Keeps a registry to skip already processed files.

Usage:
    python wiki_manuals_watcher.py --workspace /path/to/wiki
"""

import os
import sys
import json
import hashlib
import argparse
import subprocess
import shutil
from pathlib import Path
from datetime import datetime

REGISTRY_FILE = ".manuali_registry.json"

def compute_hash(pdf_path: str) -> str:
    h = hashlib.sha256()
    with open(pdf_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return f"sha256:{h.hexdigest()}"

def load_registry(manuali_dir: Path) -> dict:
    reg_path = manuali_dir / REGISTRY_FILE
    if not reg_path.exists():
        return {}
    try:
        with open(reg_path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def save_registry(manuali_dir: Path, registry: dict) -> None:
    reg_path = manuali_dir / REGISTRY_FILE
    try:
        with open(reg_path, "w", encoding="utf-8") as f:
            json.dump(registry, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"Error saving registry: {e}", file=sys.stderr)

def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True, help="Absolute path to the wiki workspace")
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    if not workspace.exists():
        print(json.dumps({"status": "error", "message": f"Workspace not found: {workspace}"}))
        sys.exit(1)

    # Resolve manuali/ directory (sibling to the wiki workspace folder)
    manuali_dir = workspace.parent / "manuali"
    if not manuali_dir.exists():
        # Fallback if manuali is inside the workspace
        manuali_dir = workspace / "manuali"
        if not manuali_dir.exists():
            print(json.dumps({"status": "error", "message": "manuali/ directory not found"}))
            sys.exit(1)

    registry = load_registry(manuali_dir)
    processed = []
    skipped = []
    failed = []

    # Path to scripts
    script_dir = Path(__file__).parent
    wiki_py = script_dir / "wiki.py"

    # Find all PDFs recursively
    pdf_files = list(manuali_dir.rglob("*.pdf"))

    for pdf_file in pdf_files:
        # Ignore PDFs inside staging or temp directories
        if ".archive" in pdf_file.parts or "pdf-inbox" in pdf_file.parts:
            continue

        pdf_name = pdf_file.name
        rel_pdf_path = pdf_file.relative_to(manuali_dir)
        
        # Determine the RPG system:
        # If inside a subfolder, use the subfolder name as the system (e.g. manuali/cyberpunk/rules.pdf -> system: cyberpunk)
        # If in the root folder, use "dnd5e" as default
        parts = rel_pdf_path.parts
        if len(parts) > 1:
            system_name = parts[0]
        else:
            # Special bypass: if filename looks like quick start or character sheet, classify, otherwise dnd5e
            system_name = "dnd5e"

        # Ignore character sheets
        if "charactersheet" in pdf_name.lower() or "scheda" in pdf_name.lower():
            continue

        current_hash = compute_hash(str(pdf_file))
        entry = registry.get(str(rel_pdf_path), {})

        if entry.get("hash") == current_hash and entry.get("status") == "success":
            skipped.append({
                "file": str(rel_pdf_path),
                "system": system_name
            })
            continue

        # Ingest PDF
        try:
            # Step 1: ingest-pdf (extracts text to rules/raw/)
            ingest_cmd = [
                sys.executable,
                str(wiki_py),
                "ingest-pdf",
                "--workspace", str(workspace),
                "--file", str(pdf_file)
            ]
            
            res_ingest = subprocess.run(ingest_cmd, capture_output=True, text=True, encoding="utf-8")
            if res_ingest.returncode != 0:
                raise RuntimeError(f"ingest-pdf failed: {res_ingest.stderr or res_ingest.stdout}")

            # Parse expected output name (with re.sub(r"[^\w\-]", "_", stem) normalization)
            import re
            normal_stem = re.sub(r"[^\w\-]", "_", pdf_file.stem)
            raw_output_md = workspace / "wiki-works" / "regole" / "raw" / f"{normal_stem}.md"

            if not raw_output_md.exists():
                raise FileNotFoundError(f"Extracted markdown not found at {raw_output_md}")

            # Step 2: Relocate to system rules directory
            system_raw_dir = workspace / "wiki-works" / "regole" / system_name / "raw"
            system_raw_dir.mkdir(parents=True, exist_ok=True)
            final_raw_md = system_raw_dir / f"{normal_stem}.md"

            shutil.move(str(raw_output_md), str(final_raw_md))

            # Step 3: process-raw (vectors embedding for that specific system)
            process_cmd = [
                sys.executable,
                str(wiki_py),
                "process-raw",
                "--workspace", str(workspace),
                "--project", system_name
            ]
            
            res_proc = subprocess.run(process_cmd, capture_output=True, text=True, encoding="utf-8")
            if res_proc.returncode != 0:
                # Rollback raw file relocation
                shutil.move(str(final_raw_md), str(raw_output_md))
                raise RuntimeError(f"process-raw failed: {res_proc.stderr or res_proc.stdout}")

            # Update registry
            registry[str(rel_pdf_path)] = {
                "hash": current_hash,
                "system": system_name,
                "status": "success",
                "processed_at": datetime.now().isoformat()
            }
            processed.append({
                "file": str(rel_pdf_path),
                "system": system_name
            })

        except Exception as e:
            registry[str(rel_pdf_path)] = {
                "hash": current_hash,
                "system": system_name,
                "status": "failed",
                "error": str(e),
                "processed_at": datetime.now().isoformat()
            }
            failed.append({
                "file": str(rel_pdf_path),
                "system": system_name,
                "error": str(e)
            })

        # Save registry incrementally after each file
        save_registry(manuali_dir, registry)

    # Print summary report
    print(json.dumps({
        "status": "ok",
        "processed": processed,
        "skipped_count": len(skipped),
        "failed": failed
    }, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()
