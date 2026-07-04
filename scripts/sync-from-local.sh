#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/extensions" "$ROOT/agents" "$ROOT/prompts"

cp "$HOME/.pi/agent/extensions/orchestrator-workflow.ts" "$ROOT/extensions/orchestrator-workflow.ts"
cp "$HOME/.pi/agent/agents/researcher.md" "$ROOT/agents/researcher.md"
cp "$HOME/.pi/agent/agents/implementor.md" "$ROOT/agents/implementor.md"
cp "$HOME/.pi/agent/agents/design.md" "$ROOT/agents/design.md"
cp "$HOME/.pi/agent/APPEND_SYSTEM.md" "$ROOT/prompts/orchestrator.md"

echo "Synced local orchestrator workflow files into $ROOT"
