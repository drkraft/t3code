# Local macOS Forgejo fork

This workflow builds the current checkout for personal use on an Apple Silicon Mac. It does not fetch upstream, merge changes, publish packages or releases, or run a server in the homelab. Integrate and validate upstream changes in the checkout first, then run this command to install the resulting fork.

Use the repository's Node 24 and `vp` toolchain. No Apple Developer subscription is required: the local build defaults to ad-hoc signing, has its own application identity, and disables automatic update feeds. It is not notarized and is not a public distribution build. macOS permissions and keychain access may need to be authorized again for the new application identity.

## Prepare a version

From a clean, committed checkout:

```sh
node scripts/local-mac.ts prepare --output-dir "$HOME/t3-local-builds/2026-09-13"
```

For repeat builds, select an existing self-signed code-signing identity from your Mac's keychain:

```sh
node scripts/local-mac.ts prepare --output-dir "$HOME/t3-local-builds/2026-09-16" \
  --signing-identity "T3 Code Forgejo Local"
```

Use the same certificate for updates and rollback builds; its SHA-1 fingerprint can be used instead
of its name to select it unambiguously. Preparation does not create or import certificates. Keep
the certificate and private key in the keychain and retain a private backup outside the repository.
This option preserves the Forgejo bundle identifier and still disables notarization and update feeds.

Choose a new output directory for each build; its parent must exist. Preparation runs focused installer, Mac build profile and desktop identity/update tests plus scripts/desktop type checks, then builds the ZIP with the existing desktop builder. It records the source commit, local version and archive SHA-256 in `local-mac-receipt.json`. It verifies the bundle identity, version, signature and absence of an automatic update feed. A failed check does not produce an installation receipt.

Preparation can run while the current application is open. The command never modifies the existing data or installs an application during this phase. Keep the ZIP and its receipt together; the receipt is for locally produced artifacts, not a signature authenticating downloaded releases.

## Install and reuse existing conversations

Quit the official T3 application, any existing fork, and any separately started T3 server using the same data. Wait for them to stop. Do not reopen them during installation or restore.

```sh
node scripts/local-mac.ts install \
  --receipt "$HOME/t3-local-builds/2026-09-13/local-mac-receipt.json" \
  --backup "$HOME/t3-local-backups/2026-09-13"
```

Keep the data, backup and application directories on the same filesystem so directory swaps can be reversed. Create the backup parent directory first and choose a new backup directory each time. The installer checks for open database and Electron profile files, then backs up `~/.t3/userdata` (including conversations, settings and secrets) and both possible Electron profiles: `~/Library/Application Support/T3 Code (Alpha)` and `~/Library/Application Support/t3code`. It does not copy worktrees outside `userdata`. Backups contain private data and credentials; keep them outside the repository and retain restrictive permissions.

The installer stages the new bundle and installs `~/Applications/T3 Code (Forgejo).app`, preserving any previous fork. It leaves the official application intact. It does not launch or terminate applications. Open the fork yourself after installation. It uses the existing `~/.t3/userdata` and Electron profile, so this is an exclusive switch, not a second synchronized copy of your conversations. Never run two servers of different versions against those data. The open-file checks detect current use, but cannot prevent another application starting during the operation; keep T3 closed throughout.

Verify conversations, projects, saved settings, source-control connections and a new test conversation before relying on the fork. Do not assume the official application can reopen data migrated by a newer fork.

## Configure Forgejo for normal launches

Select the built-in Mac environment in **Settings → Source Control** and add the Forgejo
connection with its root URL and API token. If the token is in Agent Vault, retrieve it once for
entry in this form; normal launches do not need an Agent Vault launcher. Quit and reopen after
saving, editing or removing a connection. Rescan checks authentication against the already loaded
configuration and does not apply pending changes. API tokens do not configure Git SSH or HTTPS
credentials for clone and push.

An explicitly set `T3CODE_FORGEJO_CONNECTIONS`, including `[]`, takes precedence and makes the
local editor read-only. Remove that external configuration before using the saved connections.
The encrypted registry lives in desktop state and belongs in its backups. Keychain failure has no
plaintext fallback: resolve macOS keychain access before retrying. A backup of the encrypted file
alone does not guarantee recovery on another Mac.

Before relying on a new build, qualify token recovery after relaunch, update and rollback on the
same Mac. Ad-hoc signing does not guarantee stable keychain access between builds. Selecting the
same persistent certificate avoids changing the signing identity; changing certificates still
requires native qualification and may require authorizing keychain access again.

## Restore

Quit T3 and its server again, then use the original backup:

```sh
node scripts/local-mac.ts restore --backup "$HOME/t3-local-backups/2026-09-13"
```

Restore stages the saved data before swapping directories, restores the previous fork if one existed, and moves the newer data and replaced bundle to a `before-restore-*` directory inside the backup. Nothing is launched. Newer conversations are preserved there but are no longer the active database. Do not manually merge SQLite files.

Failed staging keeps the active data untouched. A caught rename failure reverses completed swaps. A process crash or power loss leaves the backup, staged paths and `moves.json` recovery journal available for inspection; do not blindly remove them. A leftover `.t3-forgejo-install.lock` in the application directory requires confirming the installer is no longer running before manual recovery.

## Isolated qualification

Pass both overrides to use disposable state and applications:

```sh
node scripts/local-mac.ts install --receipt /tmp/build/local-mac-receipt.json \
  --backup /tmp/qa-backup --home /tmp/qa-home \
  --applications-dir /tmp/qa-apps
```

Use the same overrides for restore. They affect installation and backup only: launch the executable with `T3CODE_HOME=/tmp/qa-home` (the local fork puts its Electron profile under `/tmp/qa-home/electron-profiles`) when qualifying the app. Do not use the default launch for a disposable QA install because it would reuse the normal data paths. The installer never rewrites the executable's default data paths.

Each subsequent update repeats prepare, quit, install and manual launch. Automatic upstream integration, in-app downloads, Developer ID signing/notarization, server distribution and mobile qualification remain outside this local workflow.
