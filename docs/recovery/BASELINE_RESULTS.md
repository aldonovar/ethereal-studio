# DAW-fi recovery baseline

Date: 2026-07-29
Desktop worktree: `/home/aldonovar/Proyectos/hollow-bpm/dawfi-relaunch`
Branch: `recovery/dawfi-relaunch`
Base: `origin/main` at `aa9d093`
Web checkout: `/home/aldonovar/Proyectos/hollow-bpm/hollow-web` at `0142d0e`
Environment: Linux/Hyprland, Node `v26.5.0`, npm `12.0.1`

The only evidence states used below are `PASS`, `FAIL`, `SKIPPED`,
`NOT EXECUTED`, `BLOCKED BY ENVIRONMENT` and
`BLOCKED BY EXTERNAL CONFIGURATION`.

## Desktop baseline and checkpoint

| Check | State | Evidence |
| --- | --- | --- |
| Isolated worktree and non-main branch | PASS | Work proceeded on `recovery/dawfi-relaunch`; the dirty original checkout was not edited. |
| `npm ci --include=dev` | PASS | 604 packages installed from the lockfile. npm reported five blocked install scripts; the system Electron runtime was used for the live test. |
| `npm run typecheck` | PASS | `tsc --noEmit` completed inside the final `quality:gates` run. |
| `npm run test:unit` | PASS | 41 test files and 166 tests passed, including offline Supabase and AI gateway tests. |
| `npm run build` | PASS | 3,107 modules transformed. Largest emitted chunks were 1,116.88 kB and 1,808.47 kB before gzip. |
| `npm run test:security:client` | PASS | Built artifacts contained neither the provider SDK nor configured secret indicators. |
| `npm run quality:gates` | PASS | Typecheck, all unit tests, production build and client-bundle security gate completed together after the final dependency install. |
| `npm audit --omit=dev` | PASS | Zero production vulnerabilities after compatible transitive updates to `ws`, `form-data` and `hasown`. |
| Full dev-inclusive npm audit | FAIL | npm install reported 28 findings: 1 low, 4 moderate, 19 high and 4 critical. These remain a toolchain/development backlog. |
| Initial Electron launch | FAIL | Renderer stopped before React mounted with `Missing Supabase environment variables: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY`; the visible result was a black window. |
| Local-first startup without Supabase variables | PASS | Missing cloud configuration no longer throws during import; auth short-circuits safely and the hub reports local mode. |
| Visible Electron launch | PASS | Hyprland reported one mapped, non-hidden window titled `DAW-fi`; screenshot: `/tmp/dawfi-super-d-current.png`. |
| `SUPER+D` launcher | PASS | Runtime bind resolves to `/home/aldonovar/.local/bin/daw-fi`; a second launch leaves exactly one mapped DAW-fi window. |
| Linux desktop entry | PASS | Repository and installed entries pass `desktop-file-validate`; launcher scripts pass `bash -n`. |
| Local project create/import/save/reopen | NOT EXECUTED | The hub and local-editor entry were rendered, but project lifecycle interaction was not completed in this block. |
| Windows package/sign/install/update | BLOCKED BY ENVIRONMENT | Current host is Linux and no Windows signing environment was available. |
| Real desktop OAuth | BLOCKED BY EXTERNAL CONFIGURATION | Token-bearing handoff remains a P0 and database access for the scoped Supabase OAuth is not validated. |

### Runtime warnings

- Vite reports a mixed static/dynamic import of `desktopRuntimeService`.
- Two chunks exceed the 500 kB warning threshold.
- System Electron logs a Wayland/Vulkan compatibility warning but renders the
  application correctly; it was not the black-screen cause.
- npm blocked install scripts for Electron, esbuild, ffmpeg-static and related
  packages under the host's install-script policy.

## Web baseline

No source or lockfile changes were made to `hollow-web`; `git status` remained
clean.

| Check | State | Evidence |
| --- | --- | --- |
| `npm ci --include=dev` | PASS | 318 packages installed. |
| `npm run build` | PASS | 3,191 modules transformed with Vite 5.4.19. |
| `npm run test:contract` | PASS | `Ecosystem contract OK: src/hollowbits-core/index.ts`. |
| Cloudflare Pages local compilation | PASS | Wrangler 4.87.0 compiled the Worker and parsed two header rules. |
| Pages preview on isolated port 8790 | PASS | The default 8788 port was already occupied and preserved; Workerd served the checkout on 8790. |
| Direct routes and refresh | PASS | `/`, `/engine`, `/login`, `/desktop-auth`, `/console` and `/api/health` returned HTTP 200 from the Pages runtime. |
| Cross-origin isolation headers | PASS | HTML responses included `COOP: same-origin` and `COEP: require-corp`, plus CSP, HSTS, `nosniff` and `DENY`. |
| `/engine` browser render | PASS | Chromium rendered the DAW after a 15-second virtual-time budget; screenshot: `/tmp/dawfi-web-engine-15s.png`. |
| Pages redirect rules | FAIL | Wrangler detected an infinite-loop catch-all at generated `_redirects:11` and ignored it. |
| `npm audit --omit=dev` | FAIL | Five production findings, all classified high at package level; affected paths include direct `react-router-dom` and transitive `react-router`, `protobufjs`, `form-data` and `ws`. |
| Browser AI isolation | FAIL | Build still emits `vendor-ai` at 288.13 kB and `src/daw/services/geminiService.ts` imports `@google/genai`. |
| Real Google OAuth/login/signup | BLOCKED BY EXTERNAL CONFIGURATION | No authorized real account smoke was performed; the existing bridge still places access and refresh tokens in URLs. |
| Production Cloudflare deployment | NOT EXECUTED | Only the local Pages runtime was exercised; no remote deployment or mutation was authorized. |

### Web bundle sizes requiring follow-up

- `App-C2vy3c7S.js`: 641.41 kB, 178.29 kB gzip.
- `vendor-ai-DV5lWUig.js`: 288.13 kB, 56.43 kB gzip.
- `ml-kernels-uTmlB-4B.js`: 1,892.88 kB, 312.58 kB gzip.

## Supabase MCP evidence

| Check | State | Evidence |
| --- | --- | --- |
| Project-specific configuration present | PASS | Workspace and repository configs name `supabase_dawfi_aldonovar`, pin ref `xnmkoybfuyivmiuckpxs`, set `read_only=true` and contain no key/token. |
| OAuth callback for the isolated server | PASS | `codex mcp login supabase_dawfi_aldonovar` completed through an incognito GitHub flow. |
| Project URL lookup | PASS | The project-scoped server returned the expected ref. |
| Database catalog lookup | BLOCKED BY EXTERNAL CONFIGURATION | `list_tables` failed without returning table names or a provider error. URL lookup alone does not prove database access. |
| Keys copied into desktop build | SKIPPED | The existing web environment URL matches the expected ref, but no key was printed or propagated while database identity and the token handoff remain unresolved. |

The safe next verification is to confirm in the Supabase dashboard that GitHub
`aldonovar` can open the Database/Table Editor for this ref in the selected
organization, then run exactly one read-only `list_tables` call from the workspace
root. No remote mutation is required.
