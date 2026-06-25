---
name: wiki-setup
description: Step-by-step installation of ai-wiki-system. Rigid skill — follow every step in order without skipping.
type: rigid
---

# Wiki Setup — Guided Installation

> **This is a local skill file.**
> Access it with `Read skills/wiki-setup.md` — do NOT call a Skill tool.

**IMPORTANT: This is a rigid skill. Execute every step in the order shown. Do not skip or reorder.**

## Pre-check: identify your platform

- [ ] You are on **OpenClaw** → follow §openclaw

---

## §openclaw — Setup for OpenClaw

### Step OC-1: Verify Python dependencies

Same as CC-1.

### Step OC-2: Create wiki.config.json

Same as CC-2.

### Step OC-3: OpenClaw integration

This repository does not ship the standalone wiki-context OpenClaw plugin. For the D&D tool, install `master-dnd-plugin`; it embeds this wiki backend directly.

### Step OC-4: Initialize LanceDB

Same as CC-4.

### Step OC-5: Update your user AGENTS.md

Open `AGENTS.md` of your project (or create `~/.openclaw/AGENTS.md`) and add:

```markdown
## Wiki workspace
Active wiki workspace: <WORKSPACE>
```

### Step OC-6: Restart OpenClaw

**OpenClaw setup complete.**
