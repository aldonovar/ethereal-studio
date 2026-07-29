# Desktop/web duplication matrix

Date: 2026-07-29
Decision status: canonical package selection pending ADR-001

The web repository contains a near-copy of the desktop DAW under `src/daw` plus a
second `src/hollowbits-core`. Similarity does not authorize deleting either copy;
each row needs contract and fixture parity first.

| Domain/module | Desktop | Web | Evidence and differences | Current source decision | Risk / required parity |
| --- | --- | --- | --- | --- | --- |
| Ecosystem core | `hollowbits-core/index.ts` | `src/hollowbits-core/index.ts` | Exact SHA-256 match at audit time (prefix `b325f969…`); web contract test passes. | Extract once; neither copy remains authoritative by path. | Medium: redirect every consumer, then hash/contract test both runtimes. |
| Root DAW app | `App.tsx` | `src/daw/App.tsx` | Different hashes (`6765…` desktop, `818a…` web); file diff observed roughly 8 insertions/36 deletions in one direction, plus runtime imports. | Undecided pending responsibility split. | Critical: project lifecycle, transport and UI state fixtures in both runtimes. |
| Audio engine | `services/audioEngine.ts` | `src/daw/services/audioEngine.ts` | Large divergent hotspot; comparison observed about 301 insertions/4 deletions in the web-relative diff. | Select behavior by tests, not line count. | Critical: render, transport, recording, metering, export and interruption parity. |
| Platform service | `services/platformService.ts` | `src/daw/services/platformService.ts` | Deliberate native/browser differences plus shared logic (observed 31/39 line delta). | Split domain contract from desktop/browser adapters. | High: filesystem, permissions, encoding and error contract tests. |
| Supabase client | `services/supabase.ts` | `src/lib/supabase.ts` and DAW copy | Different storage, URL detection and offline semantics. | One auth domain with one client per runtime. | Critical: PKCE, session hydration, logout, missing config and no-token-URL tests. |
| Auth store | `stores/authStore.ts` | `src/stores/authStore.ts` plus DAW surfaces | Both parse legacy token hashes; web also crosses subdomains/cookies. | Replace with shared state domain and platform handoff adapters. | Critical: wrong state, replay, expiry, restart, logout and URL cleanup. |
| AI service | `services/aiGatewayService.ts` | `src/daw/services/geminiService.ts` | Desktop now uses provider-neutral gateway; web still bundles provider SDK. | Desktop gateway contract is the target boundary. | Critical: bundle scan, auth/quota/timeout/offline/error tests. |
| Shared component tree | `components/**` | `src/daw/components/**` | Most shared paths were byte-identical at audit time. Known differences: `AISidebar`, `CollabAuthModal`, `CollabPanel`, `ExportModal`, `MiniAuthPanel`, `ShareProjectModal`, `Timeline`, `TrackHeader`. | Move unchanged components first only after import boundary exists. | High: visual, keyboard, project-action and runtime adapter snapshots. |
| Desktop-only shell | `components/desktop/**` | none | Hub, native chrome, desktop auth and window controls are platform-specific. | Keep in desktop application package. | Medium: window lifecycle, native controls and single-instance E2E. |
| Recording/session/mixer services | `services/**` | `src/daw/services/**` | Many files are identical or near-identical but imports and audio engine side effects differ. | Shared domain package after hotspot contracts. | Critical: existing block regression suites plus web parity. |
| Project storage/archive | desktop services/adapters | browser DAW services | Same `.esp` intent with filesystem versus browser/download/IndexedDB differences. | Shared versioned serializer; runtime-specific asset stores. | Critical: real `.esp` fixtures, checksum, interrupted save and non-destructive conversion. |

## Canonicalization rules

1. The more complete verified behavior wins; repository age or line count does not.
2. Pure identical modules may move first, but only after both consumers import the
   extracted package and their contract tests pass.
3. Audio, auth, project persistence and collaboration require fixtures and side
   effect tracing before extraction.
4. Platform capabilities stay behind adapters; they do not fork domain models.
5. Legacy imports may remain as temporary aliases, with a dated removal gate.

## Required comparison evidence per future move

- public exports and inbound consumers;
- storage/network/filesystem side effects;
- serialized data and project fixtures;
- audio graph/transport authority changes;
- desktop/web unit and contract results;
- browser and Electron visual/runtime proof;
- rollback path and legacy import alias.
