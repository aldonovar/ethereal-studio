# DAW-fi codebase inventory

Date: 2026-07-29
Scope: `aldonovar/hollow-bits` plus legacy `aldonovar/hollow-web`

## Repository and application map

| Surface | Location | Current responsibility | Entrypoints |
| --- | --- | --- | --- |
| Desktop recovery | `dawfi-relaunch` | Electron shell, local DAW, native filesystem/media adapters, desktop auth and packaging | `index.tsx`, `App.tsx`, `electron/main.cjs`, `electron/preload.cjs` |
| Legacy web | `hollow-web` | Marketing, login/signup, console/settings, browser DAW and Cloudflare Pages API | `src/main.tsx`, `src/App.tsx`, `functions/api/**` |
| Desktop DAW domain | repository root plus `hollowbits-core/`, `services/`, `stores/`, `components/` | Project/audio/editor behavior and UI | `App.tsx`, `services/audioEngine.ts` |
| Web DAW copy | `hollow-web/src/daw/` and `src/hollowbits-core/` | Browser copy of most desktop DAW/domain code | `src/daw/App.tsx`, `src/daw/services/audioEngine.ts` |

Both repositories remain independent npm projects with separate lockfiles. No
canonical monorepo package boundary exists yet.

## Desktop runtime

### Process boundaries

- `electron/main.cjs` owns BrowserWindows, application lifecycle, single-instance
  behavior, file/process capabilities and custom protocol handling.
- `electron/preload.cjs` exposes the renderer bridge and is a privileged security
  boundary.
- React renders the hub and editor; desktop windows now carry the visible title
  `DAW-fi` while package/app IDs remain legacy.
- `services/platformService.ts` and `services/desktopRuntimeService.ts` abstract
  renderer calls into platform capabilities.
- `services/audioEngine.ts` is a major hotspot and coordinates Web Audio,
  scheduling, recording, metering, export and worklet-facing behavior.

### Audio and workers

- Web Audio and AudioWorklet processors exist for the transport clock, granular
  processing and sidechain compression.
- The repository includes recording, take/comp, session/scene, automation,
  mixer-routing, monitoring, integrity, recovery and performance services.
- Benchmark/gate scripts cover transport, launch, 48x8 stress, recording cycles,
  monitoring, editing, session, mixer and release readiness.
- Real hardware/live strict suites were not run in this checkpoint.

### Stores and persistence

- Zustand stores include authentication and DAW/runtime state.
- Project files use the legacy `.esp` contract; import/export uses JSZip and native
  filesystem adapters where available.
- localForage/IndexedDB and localStorage are used for projects, preferences and
  audio pools.
- Compatibility-sensitive names include `HollowBitsAudioPool`, `HollowBitsAudio`,
  `hollowbits.*` keys and `application/x-hollowbits-browser-item`.
- No persisted namespace or format was renamed in the visible rebrand block.

### Cloud and auth

- `services/supabase.ts` owns the desktop Supabase client.
- Cloud configuration uses `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY`; both are optional for a local build after this
  checkpoint.
- `stores/authStore.ts` still contains a legacy token-hash parser when cloud is
  configured. `components/desktop/DesktopAuth.tsx` still requests a
  `hollowbits://auth/callback` return.
- `services/aiGatewayService.ts` replaces direct provider access with a gateway
  contract; no provider SDK remains in the desktop renderer bundle.

### Build, test and release

- Desktop commands include `typecheck`, `test:unit`, `test:contract`,
  `test:security:client`, `quality:gates`, `build`, `build:win` and specialized
  audio/release gates.
- Electron Builder still declares `productName: HOLLOW BITS`,
  `appId: com.hollowbits.daw` and legacy Windows shortcut names. These remain
  intentionally unchanged until the installed-identity ADR and migration tests.
- Linux access is currently a user launcher plus desktop entry, not a packaged
  Linux release.

## Web runtime

### Routes

`src/App.tsx` selects route behavior by host and defines:

- studio/account: `/`, `/desktop-auth`, `/login`, `/signup`, `/console`,
  `/settings`, `/engine`;
- marketing: `/`, `/features`, `/pricing`, `/roadmap`, `/contact`, `/privacy`,
  `/terms`, plus auth/console/settings routes;
- catch-all navigation back to console where applicable.

The browser DAW lives under `/engine` and lazy-loads its application bundle.

### Cloudflare functions and static runtime

- `wrangler.toml` declares a Cloudflare Pages project named `hollow-web`, output
  directory `dist` and `compatibility_date = "2024-05-01"`.
- Pages Functions include `/api/health`, Stripe webhook handling and signed
  storage operations; additional handlers must be re-inventoried before backend
  consolidation.
- `public/_redirects` contains a catch-all that Wrangler currently rejects as an
  infinite loop.
- Static headers provide CSP, HSTS, COOP, COEP, referrer policy, `nosniff` and
  frame denial in the local Pages runtime.

### Web auth, storage and AI

- `src/lib/supabase.ts` owns the web client and implements localStorage plus
  `.hollowbits.com` cookie behavior.
- `src/stores/authStore.ts`, `src/pages/Console.tsx` and
  `src/pages/DesktopAuthBridge.tsx` read or transport access/refresh tokens in URL
  fragments. This is an open P0.
- `src/daw/services/geminiService.ts` imports `@google/genai`; Vite emits a
  dedicated browser `vendor-ai` chunk. This is an open P0.
- Browser DAW persistence duplicates desktop localForage/IndexedDB/project logic
  with platform-specific differences.

## Supabase inventory boundary

- The current application project ref is `xnmkoybfuyivmiuckpxs`, confirmed from
  the current web environment URL and public bundle without printing a key.
- Project-specific MCP configuration is read-only and contains no credential.
- A real database catalog inventory is `BLOCKED BY EXTERNAL CONFIGURATION` because
  `list_tables` failed for the isolated OAuth identity.
- Table names, RLS policies, RPCs, migrations and buckets are therefore not
  represented as remotely verified in this document. TypeScript database types
  are only client-side expectations, not proof of deployed schema.
- A local Docker Supabase stack exists on ports 54321–54327; it was not treated as
  production and was not mutated.

## Domains, protocol and external identity

- Observed legacy domains: `hollowbits.com` and `play.hollowbits.com`.
- Legacy desktop protocol: `hollowbits://`; target: `dawfi://` after one-time-code
  handoff and compatibility tests.
- Legacy installed identity: `com.hollowbits.daw`; target
  `com.allyx.dawfi` remains subject to signing/user-data ADR.
- Legacy project extension: `.esp`; `.dawfi` remains subject to container ADR.
- GitHub repository and remote names were not changed.

## CI and collaboration state

- Desktop PR #12 remains open/draft with successful checks; issues #13–15 remain
  the recovery/security/unification backlog.
- Web PR #1 remains open/draft with successful checks; web issue #2 remains open.
- No PR was merged, pushed, marked ready or modified in this checkpoint.

## Inventory gaps

| Gap | State |
| --- | --- |
| Remote Supabase tables/RLS/RPC/migrations/buckets | BLOCKED BY EXTERNAL CONFIGURATION |
| Production DNS, OAuth allowlists and Cloudflare environment verification | NOT EXECUTED |
| Windows installed paths, signing and update behavior | BLOCKED BY ENVIRONMENT |
| Real project open/save/reopen and legacy fixture set | NOT EXECUTED |
| Hardware/live audio benchmark matrix | NOT EXECUTED |
