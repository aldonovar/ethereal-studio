# DAW-fi UX defect register

Date: 2026-07-29

| ID | Priority | Surface | Defect | State | Evidence / next gate |
| --- | --- | --- | --- | --- | --- |
| UX-001 | P0 | Desktop startup | Electron opened as a completely black window when Supabase variables were absent. | PASS | Fatal renderer import reproduced, replaced with explicit local mode; mapped visible screenshot and offline regression test pass. |
| UX-002 | P0 | Desktop access | No direct keyboard/application launcher existed. | PASS | `SUPER+ALT+D`, stable `~/.local/bin/daw-fi`, Linux desktop entry and single-instance focus verified; `SUPER+D` remains Rofi. |
| UX-003 | P0 | Web/desktop auth | Access and refresh tokens are transported or parsed in URL fragments/deep links. | FAIL | Replace with opaque one-use code, PKCE/state/TTL/origin binding and replay tests before cloud login is enabled. |
| UX-004 | P0 | Web AI | Browser bundle contains direct `@google/genai` provider code. | FAIL | Remove SDK, use authenticated gateway and add web artifact scan. |
| UX-005 | P0 | Google auth | Desktop bridge button lacks the required recognizable local Google logo and shared states. | FAIL | Build shared accessible component and visual/keyboard/error tests after handoff contract. |
| UX-006 | P0 | Supabase cloud | OAuth callback completes but database access for the expected project is not validated. | BLOCKED BY EXTERNAL CONFIGURATION | Confirm GitHub `aldonovar` organization membership/Table Editor, then one read-only `list_tables`. |
| UX-007 | P1 | Local/cloud clarity | Missing cloud variables previously looked like application failure. | PASS | Hub now states `DAW-fi en modo local`; cloud/account controls are disabled and local editor remains available. |
| UX-008 | P1 | Durable launcher | Initial system integration pointed directly at the recovery worktree. | PASS | Stable wrapper now selects recovery worktree then main repository; Hyprland and `.desktop` use the wrapper. |
| UX-009 | P1 | Web navigation | Cloudflare ignores an infinite-loop catch-all redirect rule. | FAIL | Repair `_redirects`, then retest direct navigation/refresh on Pages and deployed preview. |
| UX-010 | P1 | Web loading | `/engine` presents only `CARGANDO MOTOR AUDIO...` during a heavy initial load. | FAIL | Measured render succeeded by 15 seconds, but loading progress, cancellation/failure and bundle splitting need implementation. |
| UX-011 | P1 | Performance | Desktop and web emit multi-hundred-kB/MB chunks. | FAIL | Add bundle budgets and lazy boundaries for ML kernels, DAW app and AI/provider code. |
| UX-012 | P1 | Branding | Web DAW and packaging/internal strings still show HOLLOW BITS. | FAIL | Continue visible migration only; preserve installed IDs/storage/protocol until ADR gates. |
| UX-013 | P1 | Auth availability | Desktop cloud controls cannot safely be enabled until correct environment and secure handoff exist. | BLOCKED BY EXTERNAL CONFIGURATION | Do not copy keys merely to remove local mode; close P0 handoff and validate scoped project first. |
| UX-014 | P2 | Electron diagnostics | Wayland/Vulkan compatibility warning is logged by system Electron. | FAIL | Non-blocking today; benchmark GPU/backend options before changing renderer switches. |
| UX-015 | P2 | Localization | Product copy mixes Spanish, English and legacy capitalization. | FAIL | Decide i18n/default-language ADR and migrate strings with visual checks. |

## Visual evidence

- Corrected desktop hub: `/tmp/dawfi-super-d-current.png`.
- Web `/engine` after runtime load: `/tmp/dawfi-web-engine-15s.png`.
- User-reported black-window captures remain the before-state evidence in the task.
