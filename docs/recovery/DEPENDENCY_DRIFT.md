# Dependency and toolchain drift

Date: 2026-07-29

## Runtime comparison

| Dependency/tool | Desktop recovery | Legacy web | Assessment |
| --- | --- | --- | --- |
| React | `19.2.4` | `19.2.0` declared | Align during monorepo extraction; low immediate behavioral drift. |
| TypeScript | `~5.8.2` (`5.8.3` installed) | `~5.9.3` | Compiler behavior differs; establish one root policy before shared packages. |
| Vite | `^6.2.0` (`6.4.1` installed) | `^5.4.19` | Major drift affects configuration and chunk behavior. |
| React plugin | `@vitejs/plugin-react ^5` | `^4.3.4` | Align with chosen Vite line. |
| Supabase JS | `2.105.1` | `2.105.1` | Version aligned, auth/storage implementations are not. |
| Zustand | `5.0.12` | `5.0.12` | Version aligned, stores remain duplicated. |
| `@google/genai` | removed | `1.51.0` | P0: web-only provider SDK must leave the browser bundle. |
| Electron | `40.1.0` declared; system Electron 42 used live | none | Install script was blocked locally; packaging/runtime version parity needs CI. |
| Wrangler | none | `4.87.0` | Local Pages runtime validated; deployment remains external. |
| Node/npm host | Node `26.5.0`, npm `12.0.1` | same host | Repositories do not yet enforce a common release runtime in this checkpoint. |

## Desktop audit action

The initial production audit reported two high transitive paths. A non-force,
lockfile-only compatible update changed:

- `ws` `8.19.0` → `8.21.1`;
- `form-data` `4.0.5` → `4.0.6`;
- `hasown` `2.0.2` → `2.0.4`.

After `npm ci --include=dev`:

- production audit: `PASS`, zero findings;
- full dev-inclusive audit: `FAIL`, 28 findings (1 low, 4 moderate, 19 high,
  4 critical).

Do not use `npm audit fix --force`. Attribute each remaining toolchain path,
upgrade direct packages deliberately and rerun packaging/tests.

## Web audit

The unchanged web lockfile reports five production vulnerabilities at package
level (`FAIL`), including direct `react-router-dom` and transitive
`react-router`, `protobufjs`, `form-data` and `ws`. Fix this on a web recovery
branch with route/auth regression evidence; do not mutate the clean `main`
checkout.

## Deprecated and blocked install behavior

- npm reports deprecated `inflight`, old `rimraf`/`glob`, `boolean`, legacy Lenis
  package naming and `node-domexception` paths.
- The host install-script policy blocked Electron/esbuild/ffmpeg and, on web,
  workerd/sharp/protobuf-related scripts. Existing platform packages allowed build
  and Pages runtime tests, but release CI must exercise approved clean installs.
- Desktop build warns about two oversized chunks and a mixed static/dynamic import.
- Web build emits a 1.89 MB ML kernel, 641 kB App and 288 kB AI vendor chunk.

## Alignment order

1. Close web production advisories and remove browser provider SDK.
2. Declare/test a supported Node/npm matrix in both CIs.
3. Choose one TypeScript/Vite/plugin line for the canonical workspace.
4. Establish bundle budgets before extracting shared UI/domain packages.
5. Upgrade Electron only with desktop window, IPC, audio, packaging and update
   tests; the system runtime is not release evidence.
