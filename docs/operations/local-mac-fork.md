# Local macOS Forgejo fork

This workflow builds the current checkout for personal use on an Apple Silicon Mac. It does not fetch upstream, merge changes, publish packages or releases, or run a server in the homelab. Integrate and validate upstream changes in the checkout first, then run this command to install the resulting fork.

Use the repository's Node 24 and `vp` toolchain. No Apple Developer subscription is required: the local build uses ad-hoc signing, has its own application identity, and disables automatic update feeds. It is not notarized and is not a public distribution build. macOS permissions and keychain access may need to be authorized again for the new application identity.

## Prepare a version

From a clean, committed checkout:

```sh
node scripts/local-mac.ts prepare --output-dir "$HOME/t3-local-builds/2026-09-13"
```

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
