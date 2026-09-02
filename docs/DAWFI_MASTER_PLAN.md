# DAW-fi master recovery plan

Status: active, incremental recovery
Checkpoint date: 2026-07-29
Working branch: `recovery/dawfi-relaunch`

## Objective and invariants

DAW-fi will become one desktop-first, local-first product with a shared DAW domain
for Electron and web. This is not a big-bang rewrite. The current `.esp` format,
`hollowbits://` protocol, `com.hollowbits.daw`, storage namespaces and IndexedDB
databases remain readable until versioned migrations, rollback and real fixtures
prove data safety.

Non-negotiable gates:

1. The desktop opens, creates and edits local projects without account, network,
   Supabase or AI availability.
2. No provider secret, service-role key, access token or refresh token enters a
   renderer bundle, URL, project document or log.
3. Desktop and web stop developing parallel domain implementations.
4. A build or mock test is not evidence of a real OAuth, upgrade or audio flow.
5. Remote repository, deployment, DNS, Supabase and production changes require
   explicit authorization.

## Completed checkpoint

| Work item | State | Evidence / result |
| --- | --- | --- |
| Git preflight, remote and PR/issue review | PASS | Both repositories and active draft PRs/issues were inspected without merge or push. |
| Isolated recovery branch | PASS | Original dirty desktop checkout and clean web checkout remain preserved. |
| Architecture and duplication discovery | PASS | Both applications were indexed; shared and divergent DAW surfaces were mapped. |
| Reproduce black Electron window | PASS | Fatal missing-Supabase import was captured from renderer logs. |
| Restore local-first boot | PASS | Optional cloud client, auth short-circuit, disabled cloud actions and regression test implemented. |
| Remove desktop provider SDK/secret injection | PASS | Server-only gateway boundary plus built-artifact security gate committed. |
| Visible DAW-fi shell | PASS | Browser title, Electron windows, titlebar and hub use DAW-fi while legacy IDs remain. |
| Direct desktop access | PASS | Stable user launcher, `.desktop` entry and `SUPER+ALT+D` installed and verified with single-instance behavior; `SUPER+D` remains reserved for Rofi. |
| Naming and compatibility registry | PASS | Rebrand registry, compatibility matrix and cutover plan exist. |
| Desktop quality gate | PASS | 41 files / 166 tests, typecheck, build and client security gate. |
| Web build/contract/Pages baseline | PASS | Build, contract, real local Pages routes, headers and `/engine` render exercised. |
| Supabase MCP isolation | PASS | Project-ref/read-only configuration and explicit anti-global-connector rules installed. |
| Supabase database permission | BLOCKED BY EXTERNAL CONFIGURATION | OAuth and URL lookup work; `list_tables` does not. |

## Ordered execution

### Phase 1 — close P0 security and authentication

1. Confirm the scoped Supabase account/organization can open project
   `xnmkoybfuyivmiuckpxs`; repeat only `list_tables`.
2. Replace web and desktop token URLs with an opaque, one-use, short-lived code
   bound to `state`, origin and request, exchanged over HTTPS.
3. Implement and test PKCE, expiry, wrong state, wrong host/path, replay,
   cancellation, logout and restart persistence.
4. Add one shared accessible Google button with a local official logo and all
   loading/error/retry states.
5. Remove `@google/genai` and direct provider use from the web/browser bundle and
   route requests through the same authenticated server-only gateway contract.
6. Restrict Electron filesystem IPC, navigation, new windows and protocol parsing
   before enabling cloud auth for users.

Exit gate: every auth item from the prompt is individually `PASS`; no token exists
in URLs or logs and the built web/desktop bundles contain no provider secret SDK.

### Phase 2 — canonical workspace without history loss

1. Write ADR-001 for package boundaries and ADR-005 for Pages Functions versus
   Workers + Static Assets based on the live deployment.
2. Import web history into a canonical monorepo with explicit desktop, web/site,
   API, domain, UI, auth and platform-adapter packages.
3. Select the most complete implementation per module; never copy both into the
   new package.
4. Point desktop and web contract tests at one `@dawfi/*` source before removing
   legacy files.

Exit gate: one source for project, transport, tracks, clips, mixer, recording and
shared UI contracts; both runtime builds and parity fixtures pass.

### Phase 3 — project container and data preservation

1. Inventory every `.esp` reader/writer, archive member, storage key, IndexedDB
   database and localForage store.
2. Decide the `.dawfi` envelope in ADR-002; keep a strict legacy `.esp` reader.
3. Add fixtures from real projects and malformed/interrupted cases.
4. Implement write-new/copy-on-convert, checksums, atomic replacement, backup,
   recovery journal and rollback. Never overwrite the only user copy.

Exit gate: desktop and web open the same legacy/current fixtures, interrupted
conversion recovers, and originals remain byte-for-byte available.

### Phase 4 — shared domain, engine and platform adapters

1. Separate transport authority, audio graph, scheduling, metering and persistence
   from React.
2. Define desktop/browser adapters for filesystem, encoding, windows, permissions,
   media devices and cloud access.
3. Preserve AudioWorklet/real-time boundaries and benchmark metadata.
4. Run cross-runtime project, render and export parity tests.

Exit gate: no duplicated domain behavior, no React-owned DSP loop and measured
audio reliability on described hardware/browsers.

### Phase 5 — DAW-fi product shell and UX migration

1. Establish design tokens, focus/keyboard model, density, panels and responsive
   layouts before migrating views incrementally.
2. Prioritize create/open/import, arrange/edit, record, mix, export and recovery.
3. Keep every checkpoint operable; use visual regression and reduced-motion tests.
4. Complete visible branding only after protocol/data/install compatibility gates.

Exit gate: core workflows are keyboard-accessible, visually reviewed in desktop
and web, and do not regress local project behavior.

### Phase 6 — cloud, CI and release

1. Model project-scoped optional sync, journal, conflict states and encryption
   boundaries; local editing remains authoritative when cloud is unavailable.
2. Add separate desktop/web/API CI with dependency, secret, bundle, contract,
   E2E, packaging and release gates.
3. Decide installed app ID/user-data migration in ADR-003 and verify signed update,
   side-by-side install, uninstall and rollback.
4. Coordinate domain, OAuth allowlists and repository rename only with explicit
   authorization.

Exit gate: release checklist is evidence-backed; no blocked/skipped item is called
ready and a tested rollback exists.

## Next safe block

The next implementation block is deliberately narrow:

1. Resolve the Supabase organization/database permission without requesting keys.
2. Add contracts and backend storage for a one-time desktop handoff code.
3. Replace the web token deep link and desktop token-hash parser behind tests.
4. Remove the web provider SDK and add its artifact security gate.
5. Repair the Pages catch-all rule and update the five production dependency
   findings on a separate web recovery branch.

Do not start the monorepo migration until those P0 gates are closed.
