# DAW-fi brand naming registry

Status: active migration registry
Baseline date: 2026-07-29

This registry separates user-visible brand copy from compatibility identifiers. It
must be updated before removing any legacy name.

| Surface | Current value | Target value | Class | Current decision |
| --- | --- | --- | --- | --- |
| Product display name | `HOLLOW BITS` / `Hollow Bits` | `DAW-fi` | User visible | Rename incrementally now |
| Linux launcher name | none | `DAW-fi` | User visible / OS integration | Add now |
| Browser/Electron title | `HOLLOW BITS` | `DAW-fi` | User visible | Rename now |
| npm package | `hollow-bits` | undecided | Build identity | Keep until monorepo ADR |
| Electron product name | `HOLLOW BITS` | `DAW-fi` | Installer and user data | Keep until user-data migration is proven |
| Electron app id | `com.hollowbits.daw` | `com.allyx.dawfi` | Installed identity | Legacy-only for this phase |
| Desktop auth protocol | `hollowbits://` | `dawfi://` | Protocol / OAuth | Add new protocol before retiring legacy; never carry tokens |
| Public domain | `hollowbits.com` | undecided | Domain / OAuth | External cutover required; no blind replacement |
| Project extension | `.esp` | `.dawfi` candidate | File format | Read/write compatibility remains `.esp` in this phase |
| Core import alias | `@hollowbits/core` | package boundary TBD | Code identity | Keep until shared package extraction |
| Browser drag MIME | `application/x-hollowbits-browser-item` | versioned DAW-fi MIME | Serialized contract | Dual-read migration required |
| Storage keys | `hollowbits.*` | versioned `dawfi.*` | Persisted data | Legacy read must remain; no in-place rename |
| IndexedDB | `HollowBitsAudioPool`, `HollowBitsAudio` | versioned DAW-fi DB | Persisted audio | Migration, integrity check and rollback required |
| Temp export prefix | `hollowbits-export-` | `dawfi-export-` | Ephemeral internal | Safe after compatibility audit |
| Repository | `aldonovar/hollow-bits` | `aldonovar/daw-fi` | Remote identity | No remote rename without explicit authorization |

## Allowed legacy identifiers

The following legacy identifiers are intentional until their dedicated migration
is implemented and tested:

- `com.hollowbits.daw`
- `hollowbits://`
- `hollowbits.com`
- `hollowbits.*` local-storage keys
- `HollowBitsAudioPool` and `HollowBitsAudio`
- `.esp`
- `@hollowbits/core`
- `application/x-hollowbits-browser-item`

New user-visible copy must use the canonical spelling `DAW-fi`.
