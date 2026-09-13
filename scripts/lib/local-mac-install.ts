// @effect-diagnostics nodeBuiltinImport:off - Maintainer installer uses synchronous filesystem transactions.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { LOCAL_FORK_APP_ID, LOCAL_FORK_PRODUCT_NAME } from "@t3tools/shared/localFork";

export const APP_NAME = `${LOCAL_FORK_PRODUCT_NAME}.app`;
export const BUNDLE_ID = LOCAL_FORK_APP_ID;
export interface InstallPaths {
  readonly home: string;
  readonly applications: string;
  readonly profiles: readonly string[];
}
export class LocalInstallError extends Error {
  override readonly name = "LocalInstallError";
}
const Manifest = Schema.Struct({
  home: Schema.String,
  applications: Schema.String,
  profiles: Schema.Array(Schema.String),
  entries: Schema.Array(Schema.Struct({ name: Schema.String, existed: Schema.Boolean })),
  previousApp: Schema.Boolean,
});
const decodeManifest = Schema.decodeUnknownSync(Manifest);
const entries = (paths: InstallPaths) => [
  { name: "userdata", source: NodePath.join(paths.home, "userdata") },
  ...paths.profiles.map((source, index) => ({ name: `profile-${index}`, source })),
];
function checkHandles(args: string[]) {
  const result = NodeChildProcess.spawnSync("/usr/sbin/lsof", ["-t", ...args], {
    encoding: "utf8",
  });
  if (
    result.error ||
    result.signal ||
    result.stderr.trim() ||
    (result.status !== 0 && result.status !== 1)
  ) {
    throw new LocalInstallError("Cannot establish that T3 is stopped; lsof failed.");
  }
  if (result.status === 0 || result.stdout.trim())
    throw new LocalInstallError(
      "T3 data or Electron profile is open. Quit T3 and its server, then retry.",
    );
}
export function assertStopped(paths: InstallPaths) {
  const db = NodePath.join(paths.home, "userdata", "state.sqlite");
  for (const file of [db, `${db}-wal`, `${db}-shm`])
    if (NodeFS.existsSync(file)) checkHandles([file]);
  for (const profile of paths.profiles)
    if (NodeFS.existsSync(profile)) checkHandles(["+D", profile]);
}
function copy(source: string, target: string) {
  NodeFS.cpSync(source, target, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
  });
}
function existingParent(path: string): string {
  return NodeFS.existsSync(path) ? path : existingParent(NodePath.dirname(path));
}
function canonicalPath(path: string): string {
  const parent = existingParent(path);
  return NodePath.resolve(NodeFS.realpathSync(parent), NodePath.relative(parent, path));
}
function validatePaths(paths: InstallPaths, backup: string) {
  const roots = [
    NodePath.join(paths.home, "userdata"),
    paths.applications,
    ...paths.profiles,
    backup,
  ].map((p) => NodePath.resolve(p));
  const devices = new Set(roots.map((root) => NodeFS.statSync(existingParent(root)).dev));
  if (devices.size !== 1)
    throw new LocalInstallError(
      "Data, applications and backup must be on the same filesystem for reversible renames.",
    );
  for (const [index, root] of roots.entries()) {
    if (
      NodeFS.existsSync(root) &&
      (!NodeFS.lstatSync(root).isDirectory() || NodeFS.lstatSync(root).isSymbolicLink())
    )
      throw new LocalInstallError(`Expected a real directory: ${root}`);
    for (const other of roots.slice(index + 1)) {
      const inside = NodePath.relative(canonicalPath(root), canonicalPath(other));
      const outside = NodePath.relative(canonicalPath(other), canonicalPath(root));
      if (
        !inside ||
        (!inside.startsWith(`..${NodePath.sep}`) && inside !== "..") ||
        (!outside.startsWith(`..${NodePath.sep}`) && outside !== "..")
      )
        throw new LocalInstallError(
          "Installation, data, profile and backup directories must be separate.",
        );
    }
  }
}
function locked<T>(paths: InstallPaths, action: () => T): T {
  NodeFS.mkdirSync(paths.applications, { recursive: true });
  const lock = NodePath.join(paths.applications, ".t3-forgejo-install.lock");
  NodeFS.mkdirSync(lock, { mode: 0o700 });
  try {
    return action();
  } finally {
    NodeFS.rmdirSync(lock);
  }
}
interface Installation {
  readonly paths: InstallPaths;
  readonly backup: string;
  readonly checkStopped?: (paths: InstallPaths) => void;
}
export function installBundle(input: Installation & { readonly bundle: string }) {
  const { paths, backup, bundle } = input;
  validatePaths(paths, backup);
  return locked(paths, () => {
    const stopped = input.checkStopped ?? assertStopped;
    stopped(paths);
    NodeFS.mkdirSync(backup, { mode: 0o700 });
    const targets = entries(paths);
    const app = NodePath.join(paths.applications, APP_NAME);
    const previousApp = NodeFS.existsSync(app);
    const manifest = {
      ...paths,
      entries: targets.map(({ name, source }) => ({ name, existed: NodeFS.existsSync(source) })),
      previousApp,
    };
    for (const entry of targets)
      if (NodeFS.existsSync(entry.source)) copy(entry.source, NodePath.join(backup, entry.name));
    const stage = NodePath.join(
      paths.applications,
      `.t3-forgejo-stage-${NodeCrypto.randomUUID()}.app`,
    );
    copy(bundle, stage);
    // Recheck after backup: an app started while copying invalidates this snapshot.
    stopped(paths);
    NodeFS.writeFileSync(
      NodePath.join(backup, "installation.json"),
      JSON.stringify(manifest, null, 2),
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    if (previousApp) copy(app, NodePath.join(backup, "previous.app"));
    const displaced = NodePath.join(
      paths.applications,
      `.t3-forgejo-previous-${NodeCrypto.randomUUID()}.app`,
    );
    if (previousApp) NodeFS.renameSync(app, displaced);
    try {
      NodeFS.renameSync(stage, app);
    } catch (error) {
      if (previousApp) NodeFS.renameSync(displaced, app);
      throw error;
    }
    NodeFS.writeFileSync(
      NodePath.join(backup, "installed"),
      "Installed; preserve this directory for restore.\n",
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    return app;
  });
}
export function restoreInstallation(input: Installation) {
  const { paths, backup } = input;
  validatePaths(paths, backup);
  const manifest = decodeManifest(
    JSON.parse(NodeFS.readFileSync(NodePath.join(backup, "installation.json"), "utf8")),
  );
  if (
    manifest.home !== paths.home ||
    manifest.applications !== paths.applications ||
    JSON.stringify(manifest.profiles) !== JSON.stringify(paths.profiles)
  )
    throw new LocalInstallError("Backup belongs to different data or application paths.");
  const targets = entries(paths);
  if (
    manifest.entries.length !== targets.length ||
    manifest.entries.some((entry, index) => entry.name !== targets[index]?.name)
  )
    throw new LocalInstallError("Invalid backup entries.");
  return locked(paths, () => {
    const stopped = input.checkStopped ?? assertStopped;
    stopped(paths);
    const preserved = NodePath.join(backup, `before-restore-${NodeCrypto.randomUUID()}`);
    NodeFS.mkdirSync(preserved, { mode: 0o700 });
    const moves: { source: string; saved: string; staged: string | undefined }[] = [];
    for (const [index, entry] of targets.entries()) {
      const staged = manifest.entries[index]?.existed
        ? `${entry.source}.t3-restore-${NodeCrypto.randomUUID()}`
        : undefined;
      if (staged) copy(NodePath.join(backup, entry.name), staged);
      moves.push({ source: entry.source, saved: NodePath.join(preserved, entry.name), staged });
    }
    const app = NodePath.join(paths.applications, APP_NAME);
    const stagedApp = manifest.previousApp
      ? NodePath.join(paths.applications, `.t3-restore-${NodeCrypto.randomUUID()}.app`)
      : undefined;
    if (stagedApp) copy(NodePath.join(backup, "previous.app"), stagedApp);
    moves.push({ source: app, saved: NodePath.join(preserved, "replaced.app"), staged: stagedApp });
    stopped(paths);
    // Keep a recovery journal before the first rename, including for power loss.
    NodeFS.writeFileSync(NodePath.join(preserved, "moves.json"), JSON.stringify(moves, null, 2), {
      mode: 0o600,
    });
    const completed: typeof moves = [];
    try {
      for (const move of moves) {
        if (NodeFS.existsSync(move.source)) NodeFS.renameSync(move.source, move.saved);
        completed.push(move);
        if (move.staged) NodeFS.renameSync(move.staged, move.source);
      }
    } catch (error) {
      for (const move of completed.toReversed()) {
        if (move.staged && NodeFS.existsSync(move.source))
          NodeFS.renameSync(move.source, move.staged);
        if (NodeFS.existsSync(move.saved)) NodeFS.renameSync(move.saved, move.source);
      }
      throw error;
    }
    return preserved;
  });
}
