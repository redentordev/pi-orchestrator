# Pi Orchestrator Workflow

A Pi package for an orchestrator + researcher/implementor/design delegation workflow with live per-role team status tracking.

Published npm package: `@redentor_dev/pi-orchestrator`.

It provides:

- `delegate_researcher` for read-only codebase research and context gathering.
- `delegate_implementor` for implementation and targeted validation.
- `delegate_design` for design/UI/UX review-and-fix passes after UI-affecting work.
- `review_diff` for git status plus combined diff review.
- `/team` for a persistent settings panel: per-role provider/model/thinking, master on/off, status widget on/off, detail level, and footer mode.
- `/team show | on | off | reset | minimal | default | detailed` for quick text control.

## Install

From npm:

```bash
pi install npm:@redentor_dev/pi-orchestrator@0.1.0
```

## Commands

- `/team` — open the team settings panel.
- `/team show` — summarize current team settings.
- `/team on` / `/team off` — enable or disable orchestration.
- `/team reset` — reset live status totals.
- `/team minimal|default|detailed` — set the live status widget detail level.

Disabling with `/team off` deactivates the delegate/review tools and stops orchestrator system-prompt injection until re-enabled. The state persists as `enabled` in `~/.pi/agent/orchestrator-config.json`.

## Status & footer

The live per-role status widget supports `minimal`, `default`, and `detailed` views. The status line shows `● team` when active and `○ team off` when disabled.

When the status widget is on, the built-in Pi footer is replaced by a directory-only line showing cwd, git branch, session name, and team indicator. This is configurable in the panel's **Footer** setting (`replaceFooter` in `~/.pi/agent/orchestrator-config.json`).

## Reliability

Delegation session resume resolves the exact subagent session file, so resuming works across different cwds. If a resume target is missing, the result is clearly flagged: `⚠ resume miss — started fresh`.

## Important migration note

If you currently run the local copy from `~/.pi/agent`, remove these before enabling this package to avoid duplicate tools and duplicate prompt injection:

- `~/.pi/agent/extensions/orchestrator-workflow.ts`
- `~/.pi/agent/APPEND_SYSTEM.md`

The package ships bundled default agents, but `/team` always writes user overrides to `~/.pi/agent/agents/`. Those user files take precedence over bundled defaults.

## Auth requirements

Configure auth for each provider used by the orchestrator or subagents. Use `/login <provider>` for OAuth-backed providers, or set the provider's required API key environment variable for API-key providers before starting Pi.

## Security and releases

- The package does not include local Pi state, auth files, npm tokens, or `node_modules`.
- npm publishing is configured for the public registry with public package access.
- GitHub Actions publishes tagged releases (`v*`) using the repository secret `NPM_TOKEN`.
