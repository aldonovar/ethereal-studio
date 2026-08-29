# DAW-fi rebrand cutover plan

Status: in progress; visible-shell phase only.

## Phase A — registry and visible shell

- Maintain the naming and compatibility registries.
- Rename browser title, desktop title bar and hub copy to `DAW-fi`.
- Add the Linux application entry and `SUPER+D` launcher.
- Keep app id, user-data directory, protocol, storage keys and `.esp` unchanged.
- Gate: local build, unit tests, visible Electron capture and shortcut verification.

## Phase B — protocol and auth

- Implement `dawfi://auth/callback` with an opaque, single-use code.
- Accept `hollowbits://auth/callback` only as an allowlisted compatibility route.
- Remove token-bearing URL fragments from desktop and web.
- Coordinate Supabase redirect URLs from the project-scoped `aldonovar` connection.
- Gate: PKCE, replay, expiry, wrong-state and wrong-host tests.

## Phase C — project and persisted data

- Decide the `.dawfi` container through ADR-002.
- Add dual readers and non-destructive conversion from `.esp`.
- Migrate storage and IndexedDB with lock, backup, integrity checks and rollback.
- Gate: interruption recovery and cross-runtime fixture parity.

## Phase D — installed identity and infrastructure

- Decide app id and user-data strategy through ADR-003.
- Verify signed update, side-by-side install, shortcuts, file associations and uninstall.
- Coordinate domain, OAuth, CI, deployments and repository references.
- Rename the GitHub repository only after explicit authorization.

## Current rollback

The visible-shell change can be reverted without touching projects or user data.
The legacy identifiers listed in `BRAND_NAMING_REGISTRY.md` remain authoritative
for compatibility throughout this phase.
