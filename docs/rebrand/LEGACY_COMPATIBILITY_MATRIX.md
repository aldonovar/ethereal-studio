# DAW-fi legacy compatibility matrix

Status: compatibility required; removal versions are not yet approved.

| Legacy surface | Reader today | Migration boundary | Removal gate | Rollback |
| --- | --- | --- | --- | --- |
| `.esp` projects | Desktop and web importers | Add versioned container reader before introducing `.dawfi` | Fixtures open identically in both runtimes | Keep original `.esp`; never overwrite during conversion |
| `hollowbits.*` storage | Renderer services and tests | Dual-read, write-new, then telemetry-free cleanup | Idempotent migration tests and recovery fixtures | Read legacy namespace indefinitely for one major line |
| `HollowBitsAudioPool` / `HollowBitsAudio` | IndexedDB/localForage audio cache | Copy with lock, checksum and quota handling | Reopen audio after restart and simulated interruption | Preserve legacy DB until verified copy |
| `hollowbits://` | Electron auth callback | Register `dawfi://` in parallel; allowlisted host/path only | One-time-code handoff proven; no token URLs | Keep strict legacy callback alias temporarily |
| `com.hollowbits.daw` | Installer/OS/user-data identity | ADR-003 plus side-by-side/update test | Signed update, uninstall and user-data migration verified | Continue shipping old app id |
| `hollowbits.com` | OAuth, cookies, navigation | DNS/redirect/OAuth coordinated cutover | All callback allowlists and subdomains verified | Restore old routes and cookie scope |
| `@hollowbits/core` | Desktop and web imports | Extract one canonical shared package | Contract and parity suites consume one source | Alias old import to new package |
| Legacy logo/assets | README and auth surfaces | Add DAW-fi assets before deletion | Visual snapshots and installer rollback assets exist | Retain old assets in release branch |

## Non-negotiable rules

1. Persisted identifiers are not changed in the same commit as visible copy.
2. Auth callbacks never transport access or refresh tokens.
3. A migration writes backups before changing user data and is idempotent.
4. Remote repository, DNS, OAuth, database and bucket changes require explicit authorization.
5. Legacy support is removed only with evidence from real upgrade and rollback tests.
