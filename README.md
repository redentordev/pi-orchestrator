# Pi Orchestrator Workflow

A Pi package for an orchestrator + researcher/implementor/design delegation workflow with live per-role agents status tracking.

Published npm package: `@redentor_dev/pi-orchestrator`.

It provides:

- `delegate_researcher` for read-only codebase research and context gathering.
- `delegate_implementor` for implementation and targeted validation.
- `delegate_design` for design/UI/UX review-and-fix passes after UI-affecting work.
- `review_diff` for git status plus combined diff review.
- `/agents` to inspect or configure per-role provider/model/thinking.
- `/agents-status` to show, reset, enable, disable, or change the live agents status widget view (`minimal`, `default`, `detailed`).

## Install

From npm:

```bash
pi install npm:@redentor_dev/pi-orchestrator@0.1.0
```

## Commands

- `/agents` — view and configure the orchestrator and per-role agent provider/model/thinking settings.
- `/agents-status` — show, reset, enable, disable, or change the live agents status widget view.

## Important migration note

If you currently run the local copy from `~/.pi/agent`, remove these before enabling this package to avoid duplicate tools and duplicate prompt injection:

- `~/.pi/agent/extensions/orchestrator-workflow.ts`
- `~/.pi/agent/APPEND_SYSTEM.md`

The package ships bundled default agents, but `/agents` always writes user overrides to `~/.pi/agent/agents/`. Those user files take precedence over bundled defaults.

## Auth requirements

Configure auth for each provider used by the orchestrator or subagents. Use `/login <provider>` for OAuth-backed providers, or set the provider's required API key environment variable for API-key providers before starting Pi.

## Security and releases

- The package does not include local Pi state, auth files, npm tokens, or `node_modules`.
- npm publishing is configured for the public registry with public package access.
- GitHub Actions publishes tagged releases (`v*`) using the repository secret `NPM_TOKEN`.
