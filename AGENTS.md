# DAW-fi repository instructions

These rules apply to every task in this repository.

## Code discovery

1. Prefer the configured codebase knowledge graph for functions, classes, routes,
   callers and architecture.
2. Use text search for literals, logs, generated artifacts and configuration files,
   or when the graph has no useful result.
3. Inspect `git status` before editing and preserve unrelated user work.

## Repository shape and commands

- The current desktop application is Electron + React + TypeScript + Vite.
- `electron/main.cjs` and `electron/preload.cjs` are privileged boundaries.
- `hollowbits-core/`, `services/`, `stores/` and the project serializers contain
  domain behavior that must eventually have one canonical implementation shared
  with the web runtime.
- Install with `npm ci --include=dev`.
- Required desktop gate: `npm run quality:gates`.
- Production dependency check: `npm audit --omit=dev`.
- Validate the Linux launcher with `bash -n scripts/launch-dawfi-desktop.sh` and
  `desktop-file-validate packaging/linux/daw-fi.desktop`.

## Supabase boundary

- For DAW-fi use only the project-scoped MCP server
  `supabase_dawfi_aldonovar` from `.codex/config.toml`.
- The expected project ref is `xnmkoybfuyivmiuckpxs` and its owner access must be
  authenticated through the personal GitHub account `aldonovar`.
- Never substitute a global Codex Supabase connector or a connector authenticated
  to another account.
- Keep MCP access project-scoped and read-only unless the user explicitly approves
  a specific remote write.
- Never print, log or commit keys or OAuth tokens. Browser builds may receive only
  a publishable/anon key through an ignored `.env.local`; service-role keys are
  server-only.
- Missing cloud configuration must not prevent the local desktop application from
  starting or opening projects.

## Sensitive and privileged surfaces

- Treat `.env*`, OAuth callbacks, Electron protocols, filesystem IPC, preload
  bridges, project archives, audio assets and auth/session storage as sensitive.
- Do not put provider SDK credentials, service-role keys, access tokens or refresh
  tokens in browser/renderer bundles, URLs, logs, cookies readable by JavaScript or
  project files.
- Renderer input is untrusted. Validate IPC channels, payloads and resolved paths
  in the main process and keep Electron navigation/window creation allowlisted.

## Audio and project rules

- Do not move real-time scheduling, metering or DSP loops into React render paths.
- Preserve a single transport authority and explicit audio-thread boundaries.
- Keep `.esp`, `hollowbits://`, `com.hollowbits.daw`, legacy storage keys and
  IndexedDB names compatible until their ADR, migration, rollback and fixtures are
  complete.
- Persisted data migrations must be versioned, idempotent, interruption-safe and
  non-destructive. Never overwrite the only copy of a user project.
- Do not create a second DAW domain implementation. New shared behavior belongs in
  the future canonical package boundary, with desktop and web platform adapters.

## Product, Cloudflare and completion

- User-visible product copy uses `DAW-fi`; internal legacy identifiers may remain
  only where required for compatibility.
- The web deployment currently uses Cloudflare Pages Functions. Do not migrate it
  to Workers + Static Assets until ADR-005 compares the live runtime and rollback.
- A change is done only when its relevant typecheck, tests, build, security gate and
  visible/runtime behavior pass. `SKIPPED` and external configuration blockers are
  reported explicitly and never represented as `PASS`.
- Use focused commits. Do not combine auth, persistent rebranding, project-format
  changes, monorepo migration and visual redesign in one commit.
