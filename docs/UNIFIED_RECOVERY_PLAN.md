# HOLLOW BITS — Unified Recovery and Optimization Plan

Status: initial technical recovery baseline  
Canonical product repository: `aldonovar/hollow-bits`  
Companion repository under migration: `aldonovar/hollow-web`

## 1. Executive decision

HOLLOW BITS should converge into one npm-workspaces monorepo, using `hollow-bits` as the canonical repository. The desktop DAW, web product, shared DAW UI, ecosystem contracts, platform adapters, test utilities and deployment configuration must stop evolving as copied source trees.

The current two-repository arrangement has already produced configuration drift, duplicated application code and environment-specific defects. The target is not to combine two bundles indiscriminately. The target is to establish one source of truth with explicit runtime boundaries:

```text
hollow-bits/
  apps/
    desktop/               # Electron shell and desktop composition root
    web/                   # Marketing, account console and browser DAW entry
  packages/
    core/                  # Schemas, tiers, feature flags and contracts
    daw/                   # Shared DAW domain, UI and browser-compatible engine
    platform/              # Runtime-neutral platform interfaces
    platform-electron/     # Electron implementations and IPC client
    platform-web/          # Browser/Supabase implementations
    config/                # Shared TypeScript, Vite and Vitest configuration
    test-utils/            # Fixtures, contract suites and reliability harnesses
  functions/               # Cloudflare Pages Functions / server-only integrations
  docs/
  benchmarks/
```

Use npm workspaces initially because both repositories already use npm lockfiles. Toolchain migration to pnpm or Turborepo should be considered only after the codebase is stable and reproducible.

## 2. Confirmed current-state findings

### 2.1 Duplicated shared contract

The ecosystem contract exists in both:

- `hollowbits-core/index.ts`
- `hollow-web/src/hollowbits-core/index.ts`

They currently have the same blob SHA, but parity is protected only by `scripts/verify-ecosystem-contract.mjs`. That script searches hard-coded local filesystem locations and silently skips peer comparison when the second checkout is absent. A normal isolated CI checkout can therefore pass while the repositories diverge.

Recovery action: move this file into `packages/core`, import it through a workspace dependency, and delete both copies after migration.

### 2.2 Duplicated DAW implementation

The web repository contains a substantial copy under `src/daw`, while the desktop repository owns the parallel root-level DAW implementation. The two `App.tsx` files are already different. This creates a dual-maintenance system for audio behavior, project recovery, collaboration, UI state and platform integration.

Recovery action: move runtime-neutral DAW code into `packages/daw`; isolate Electron and browser capabilities behind typed platform adapters.

### 2.3 AI secret and runtime defect

The desktop Vite configuration injects `GEMINI_API_KEY` into renderer JavaScript. Any secret embedded by Vite is recoverable from the built application. The web copy of `geminiService.ts` reads `process.env.GEMINI_API_KEY`, but the web Vite configuration does not define that value; loading the browser DAW can therefore fail at runtime with `process is not defined`.

Recovery action: remove direct provider SDK initialization from every renderer/browser bundle. Route AI operations through authenticated server endpoints with quota enforcement, input validation, timeouts and auditable error envelopes.

### 2.4 Electron IPC has excessive filesystem authority

The preload bridge exposes `readFileFromPath(filePath)` and the main process reads any renderer-supplied path up to 512 MB. Directory scanning similarly accepts renderer-supplied directories. Context isolation is enabled, but a renderer compromise would still inherit broad filesystem read access.

Recovery action: replace raw path authority with capability-based access. Paths must originate from a native chooser or an approved workspace grant, receive an opaque token, and be revalidated in the main process for every operation. Add origin/navigation restrictions, `sandbox: true` where compatible, URL allowlists and structured IPC validation.

### 2.5 Split deployment model

The web README recommends Vercel, while the repository implements Cloudflare Pages Functions, `wrangler.toml`, `_headers` and `_redirects`. Vercel does not execute the Cloudflare `functions/` runtime as-is, and its catch-all rewrite can return the SPA shell for `/api/*` requests.

Recovery action: make Cloudflare Pages the single supported production runtime during recovery. Remove or quarantine Vercel configuration unless a complete Vercel Functions adapter is intentionally maintained and tested.

### 2.6 CI asymmetry

The desktop repository has a Windows quality workflow; the web repository has no GitHub Actions quality workflow. Recent head commits do not expose PR workflow runs through the connected GitHub data. The desktop workflow also allows live capture to fail and skips all dependent hardware gates, which is acceptable only when the resulting release status is explicitly classified as core-only rather than fully validated.

Recovery action: add deterministic web build/contract CI immediately. Later add a monorepo matrix for core, web, desktop, unit, integration, security and packaging checks.

### 2.7 Toolchain and dependency drift

The repositories use different Vite, TypeScript, React plugin and Node type versions. The web package also contains both `lenis` and the legacy `@studio-freight/lenis`, while only `lenis` is referenced, and includes `@tauri-apps/api` without a source reference found during the initial audit.

Recovery action: centralize versions through workspace root dependencies, remove unused packages after reproducible build verification, and introduce dependency review/lockfile checks.

### 2.8 Web bundle composition is unnecessarily broad

Marketing pages are eagerly imported even on `play.*` and `console.*` hosts. GSAP, ScrollTrigger and Lenis are initialized globally before host-specific routing, including application surfaces that do not require marketing smooth scrolling. The DAW is lazy-loaded, but the shell still carries avoidable marketing initialization and dependency parsing.

Recovery action: split marketing, console and engine into explicit lazy route modules or separate Vite entries; initialize animation infrastructure only inside the marketing layout.

## 3. Recovery phases

## Phase P0 — Containment and reproducibility

Completion criteria: both current repositories build deterministically; critical secret/runtime defects are contained; deployment behavior is unambiguous; every change is gated by CI.

1. Add web CI: `npm ci`, ecosystem contract verification and production build.
2. Declare Cloudflare Pages as the canonical web runtime.
3. Add release-blocking checks for accidental client-side secrets.
4. Replace browser/renderer Gemini calls with an authenticated server API.
5. Harden Electron navigation, window creation and IPC validation.
6. Add focused tests for IPC authorization, auth callback state validation and web `/engine` bootstrap.
7. Record known hardware-gate limitations distinctly from a full release pass.
8. Freeze duplicated feature development until shared-code extraction begins.

## Phase P1 — Monorepo unification

Completion criteria: one repository, one lockfile, one core contract and one shared DAW package.

1. Create root npm workspaces and shared TypeScript configuration.
2. Import `hollow-web` history or source into `apps/web` using a documented migration commit.
3. Move Electron runtime into `apps/desktop`.
4. Extract `packages/core` and replace both aliases with a workspace dependency.
5. Extract platform-neutral DAW code into `packages/daw`.
6. Define `PlatformService` interfaces for filesystem, auth, storage, export, external URLs and native window controls.
7. Implement `platform-electron` and `platform-web` packages.
8. Delete duplicated DAW and core trees only after cross-runtime contract tests pass.
9. Archive `hollow-web` after its production deployment has moved to the monorepo.

## Phase P2 — Correctness and domain recovery

Completion criteria: project data, transport, recording and collaboration behavior are protected by cross-runtime regression suites.

1. Consolidate project schema migrations and validate every load/save boundary.
2. Add property tests for project repair and serialization.
3. Add deterministic transport-clock tests independent of UI timing.
4. Exercise recording journals through interruption, retry and recovery scenarios.
5. Validate collaboration commands for ordering, idempotency and authorization.
6. Add storage and quota contract tests against Supabase functions.
7. Establish golden project fixtures covering schema versions and corrupted inputs.
8. Add browser-engine smoke tests and packaged Electron smoke tests.

## Phase P3 — Performance optimization

Completion criteria: optimizations are measured against committed budgets rather than inferred from UI feel.

1. Profile renderer commits, timeline virtualization and metering fan-out.
2. Split web marketing, console and DAW chunks by runtime surface.
3. Move CPU-heavy audio/ML work behind workers or worklets where appropriate.
4. Define memory ceilings for imports, decoded audio, waveform caches and undo history.
5. Introduce benchmark baselines with environment metadata and regression thresholds.
6. Separate hardware-dependent release evidence from deterministic CI evidence.
7. Measure cold start, project open, 48x8 session launch, transport drift and export throughput.

## 4. Required CI architecture

The unified repository should expose these required checks:

```text
core-contract
web-typecheck-build
web-api-tests
desktop-typecheck-unit
electron-security-tests
project-schema-fixtures
transport-regression
recording-recovery
package-windows-x64
secret-scan
dependency-review
```

Hardware audio validation should publish signed artifacts and environment metadata. It must not be represented as passed when live capture was skipped.

## 5. Security acceptance criteria

- No provider secret is present in browser or Electron renderer bundles.
- No IPC handler accepts unrestricted filesystem paths from the renderer.
- External URLs and authentication callbacks use explicit protocol/host allowlists.
- Browser windows reject unexpected navigation and new-window requests.
- Every server function validates authentication, authorization, payload shape and quota.
- Supabase service-role credentials remain server-only.
- Web CSP and cross-origin isolation are tested in the deployed runtime.
- Logs redact tokens, callback fragments, personal data and provider responses.

## 6. Definition of recovery complete

Recovery is complete only when:

1. production web and desktop are built from the same repository and lockfile;
2. shared contracts and DAW domain code have one source of truth;
3. all P0 security defects are closed;
4. deterministic CI is green on every PR;
5. hardware validation has a separate, explicit evidence state;
6. project migration fixtures load without data loss;
7. performance budgets are measured and release-blocking;
8. the legacy `hollow-web` repository is archived with a migration notice.

## 7. Immediate implementation order

1. Merge the web baseline CI/deployment correction PR.
2. Open focused P0 issues for AI boundary, Electron IPC and deployment verification.
3. Create the workspace skeleton in `hollow-bits` without moving production code yet.
4. Add `packages/core` and switch both applications to it.
5. Import the web application under `apps/web`.
6. Extract the DAW package incrementally, one subsystem at a time, with parity tests.
7. Decommission copied trees only after validated equivalence.

This plan is intentionally migration-first. A direct bulk merge of both source trees would preserve the current duplication and make correctness harder to prove.