# DAW-fi deployment and runtime map

Date: 2026-07-29

## Current surfaces

| Surface | Source/runtime | Current identity | Verification | Mutation status |
| --- | --- | --- | --- | --- |
| Desktop development | `dawfi-relaunch`, Vite build + Electron | Visible `DAW-fi`; legacy `com.hollowbits.daw` and user-data identity | PASS on Linux/Hyprland with system Electron 42 | Local branch only |
| Linux user access | `~/.local/bin/daw-fi`, user `.desktop`, Hyprland bind | `SUPER+ALT+D` / DAW-fi; `SUPER+D` / Rofi | PASS, one mapped window and single-instance behavior | Installed for current user |
| Windows package | Electron Builder NSIS x64 | `HOLLOW BITS`, legacy app ID/shortcut | BLOCKED BY ENVIRONMENT | Not built or published |
| Marketing web | `hollow-web` host-routed React app | `hollowbits.com` | Local Pages root route PASS; production behavior not re-smoked | No remote write |
| Browser studio | same web build | `play.hollowbits.com`, `/engine` | Local Pages route/refresh/header/render PASS | No remote write |
| Edge API | Cloudflare Pages Functions | `/api/health`, webhook/storage handlers | Local `/api/health` PASS | No remote write |
| Supabase | hosted project ref `xnmkoybfuyivmiuckpxs` | Project-specific OAuth/MCP | URL PASS; database catalog BLOCKED BY EXTERNAL CONFIGURATION | Read-only; no remote mutation |
| Local Supabase | Docker ports 54321–54327 | development stack | Presence observed only | Untouched |
| GitHub desktop | `aldonovar/hollow-bits` | main plus draft PR #12 | Remote refs/checks inspected | No push/merge/edit |
| GitHub web | `aldonovar/hollow-web` | main plus draft PR #1 | Remote refs/checks inspected | No push/merge/edit |

## Cloudflare state

- `wrangler.toml` declares Pages output `dist`, project name `hollow-web` and
  compatibility date `2024-05-01`.
- The real local Pages runtime compiled Functions and served direct SPA routes on
  an isolated port.
- The default port 8788 belonged to a pre-existing process and was not killed;
  verification used 8790 and stopped it afterward.
- Two header rules are accepted. One generated catch-all redirect is rejected as
  an infinite loop.
- Production deployment, environment parity, custom domains, DNS and rollback are
  `NOT EXECUTED`.
- Pages Functions versus Workers + Static Assets remains ADR-005; no migration is
  authorized merely because a newer platform option exists.

## Supabase and environment handling

- Desktop variable names: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- Web `.env` contains only those two names; its URL resolves to the expected project
  ref. Values were not printed, copied or committed.
- Codex workspace configuration scopes MCP access to the expected ref and
  `read_only=true`; OAuth credentials live outside the repository.
- The global Supabase connector is explicitly forbidden for this workspace.
- Do not enable the desktop cloud build until the account can access the database
  catalog and the token deep-link P0 is replaced.

## Domain and cutover dependencies

Before any DAW-fi domain/app-ID/repository cutover:

1. inventory production DNS and Cloudflare project bindings;
2. verify Supabase and Google OAuth redirect allowlists;
3. deploy one-time-code handoff with both `dawfi://` and strict legacy
   `hollowbits://` callbacks;
4. test cookies, navigation and refresh on every legacy/custom host;
5. prove installed user-data/project migration and rollback;
6. obtain explicit authorization for DNS, production deploy, repository rename or
   archival.

## Rollback

- Visible desktop branding and the user launcher do not change project data or
  installed app identity.
- Hyprland pre-change backup:
  `/home/aldonovar/.config/hypr/UserConfigs/UserKeybinds.conf.pre-dawfi-20260729`.
- `SUPER+D` retains the application menu (Rofi); `SUPER+ALT+D` opens DAW-fi.
- The stable launcher checks the recovery worktree first and the original desktop
  repository second, allowing integration to move after merge without changing
  the keybinding again.
