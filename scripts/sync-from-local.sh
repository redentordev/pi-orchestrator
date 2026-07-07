#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/extensions" "$ROOT/agents" "$ROOT/prompts"

cp "$HOME/.pi/agent/extensions/orchestrator-workflow.ts" "$ROOT/extensions/orchestrator-workflow.ts"
for agent in researcher implementor design; do
  cp "$HOME/.pi/agent/agents/$agent.md" "$ROOT/agents/$agent.md"
done
if [[ -f "$HOME/.pi/agent/prompts/orchestrator.md" ]]; then
  cp "$HOME/.pi/agent/prompts/orchestrator.md" "$ROOT/prompts/orchestrator.md"
elif [[ -f "$HOME/.pi/agent/APPEND_SYSTEM.md" ]]; then
  cp "$HOME/.pi/agent/APPEND_SYSTEM.md" "$ROOT/prompts/orchestrator.md"
fi

echo "Synced local orchestrator workflow files into $ROOT"
