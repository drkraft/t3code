// @effect-diagnostics nodeBuiltinImport:off - Tests exercise real filesystem and macOS tools.
import * as Effect from "effect/Effect";
import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "@effect/vitest";
import { APP_NAME } from "./local-mac-install.ts";
import { hashFile, readPreparedBundle, run, writeReceipt } from "./local-mac-artifact.ts";

const roots: string[] = [];
const version = "0.0.40-forgejo-local.123456789.g123456789abc";
const commit = "123456789abc" + "a".repeat(28);
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-local-artifact-test-"));
  roots.push(root);
  return root;
}
it("rejects a changed ZIP before extraction", () => {
  const root = fixture();
  const archive = NodePath.join(root, "fork.zip");
  NodeFS.writeFileSync(archive, "prepared");
  const receipt = NodePath.join(root, "local-mac-receipt.json");
  NodeFS.writeFileSync(
    receipt,
    JSON.stringify({ version, commit, archive: "fork.zip", sha256: hashFile(archive) }),
  );
  NodeFS.writeFileSync(archive, "changed");
  expect(() => readPreparedBundle(receipt, root)).toThrow(/checksum/);
});
it("rejects a receipt pointing outside its build directory", () => {
  const root = fixture();
  const receipt = NodePath.join(root, "local-mac-receipt.json");
  NodeFS.writeFileSync(
    receipt,
    JSON.stringify({ version, commit, archive: "../fork.zip", sha256: "a".repeat(64) }),
  );
  expect(() => readPreparedBundle(receipt, root)).toThrow(/receipt/);
});
it.effect("installs and restores a real signed local ZIP through the CLI", () =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) !== "darwin") return;
    const root = fixture();
    const source = NodePath.join(root, "source");
    const bundle = NodePath.join(source, APP_NAME);
    NodeFS.mkdirSync(NodePath.join(bundle, "Contents", "MacOS"), { recursive: true });
    NodeFS.copyFileSync("/usr/bin/true", NodePath.join(bundle, "Contents", "MacOS", "test"));
    NodeFS.writeFileSync(
      NodePath.join(bundle, "Contents", "Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.drkraft.t3code.forgejo</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleExecutable</key><string>test</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
    );
    run("/usr/bin/codesign", ["--force", "--sign", "-", bundle]);
    const output = NodePath.join(root, "output");
    NodeFS.mkdirSync(output);
    run("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, NodePath.join(output, "fork.zip")]);
    const receipt = writeReceipt(output, version, commit);
    const extracted = readPreparedBundle(receipt, output);
    expect(NodeFS.readFileSync(NodePath.join(extracted, "Contents", "MacOS", "test"))).toEqual(
      NodeFS.readFileSync(NodePath.join(bundle, "Contents", "MacOS", "test")),
    );
    const home = NodePath.join(root, "home");
    const applications = NodePath.join(root, "Applications");
    const backup = NodePath.join(root, "backup");
    NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
    const database = NodePath.join(home, "userdata", "state.sqlite");
    NodeFS.writeFileSync(database, "conversations before install");
    const executable = yield* HostProcessExecutablePath;
    const cli = NodeURL.fileURLToPath(new URL("../local-mac.ts", import.meta.url));
    const paths = ["--home", home, "--applications-dir", applications, "--backup", backup];
    run(executable, [cli, "install", "--receipt", receipt, ...paths]);
    expect(NodeFS.existsSync(NodePath.join(applications, APP_NAME))).toBe(true);
    NodeFS.writeFileSync(database, "conversations after install");
    run(executable, [cli, "restore", ...paths]);
    expect(NodeFS.readFileSync(database, "utf8")).toBe("conversations before install");
    expect(NodeFS.existsSync(NodePath.join(applications, APP_NAME))).toBe(false);
  }),
);
