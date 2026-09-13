// @effect-diagnostics nodeBuiltinImport:off - Local build receipts use Node and macOS archive utilities.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";
import { isLocalForkVersion } from "@t3tools/shared/localFork";
import { APP_NAME, BUNDLE_ID, LocalInstallError } from "./local-mac-install.ts";

const Receipt = Schema.Struct({
  version: Schema.String,
  commit: Schema.String,
  archive: Schema.String,
  sha256: Schema.String,
});
const decodeReceipt = Schema.decodeUnknownSync(Receipt);
export function run(command: string, args: string[], inherit = false) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
  if (result.error || result.status !== 0)
    throw new LocalInstallError(
      `Command failed: ${command} ${args.join(" ")}${result.stderr ? `\n${result.stderr}` : ""}`,
    );
  return result.stdout?.trim() ?? "";
}
export function hashFile(path: string) {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
}
export function validateBundle(bundle: string, version: string) {
  if (NodeFS.lstatSync(bundle).isSymbolicLink() || !NodeFS.lstatSync(bundle).isDirectory())
    throw new LocalInstallError("Expected a real app bundle.");
  const plist = NodePath.join(bundle, "Contents", "Info.plist");
  const id = run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist]);
  const actualVersion = run("/usr/bin/plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    "-o",
    "-",
    plist,
  ]);
  if (id !== BUNDLE_ID || actualVersion !== version)
    throw new LocalInstallError(
      "Archive bundle identity/version does not match local fork receipt.",
    );
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  if (NodeFS.existsSync(NodePath.join(bundle, "Contents", "Resources", "app-update.yml")))
    throw new LocalInstallError("Local fork must not contain an automatic update feed.");
}
export function unpackArchive(archive: string, directory: string, version: string) {
  const members = run("/usr/bin/unzip", ["-Z1", archive]).split("\n");
  if (
    members.some(
      (member) =>
        !member.startsWith(`${APP_NAME}/`) ||
        member.split("/").includes("..") ||
        member.includes("\\"),
    )
  )
    throw new LocalInstallError("Archive contains unexpected paths.");
  const extracted = NodeFS.mkdtempSync(NodePath.join(directory, ".verified-"));
  run("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
  const bundle = NodePath.join(extracted, APP_NAME);
  validateBundle(bundle, version);
  return bundle;
}
export function writeReceipt(directory: string, version: string, commit: string) {
  const archives = NodeFS.readdirSync(directory).filter((name) => name.endsWith(".zip"));
  const archive = archives.length === 1 ? archives[0] : undefined;
  if (!archive) throw new LocalInstallError("Expected exactly one ZIP build artifact.");
  unpackArchive(NodePath.join(directory, archive), directory, version);
  const receipt = { version, commit, archive, sha256: hashFile(NodePath.join(directory, archive)) };
  const path = NodePath.join(directory, "local-mac-receipt.json");
  NodeFS.writeFileSync(path, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: "wx" });
  return path;
}
export function readPreparedBundle(receiptPath: string, stageDirectory: string) {
  const receipt = decodeReceipt(JSON.parse(NodeFS.readFileSync(receiptPath, "utf8")));
  if (
    !isLocalForkVersion(receipt.version) ||
    !/^[0-9a-f]{40}$/.test(receipt.commit) ||
    !/^[0-9a-f]{64}$/.test(receipt.sha256) ||
    NodePath.basename(receipt.archive) !== receipt.archive ||
    !receipt.archive.endsWith(".zip")
  )
    throw new LocalInstallError("Invalid local build receipt.");
  const archive = NodePath.resolve(receiptPath, "..", receipt.archive);
  if (hashFile(archive) !== receipt.sha256)
    throw new LocalInstallError("Archive checksum differs from the prepared build.");
  return unpackArchive(archive, stageDirectory, receipt.version);
}
