import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
// @effect-diagnostics nodeBuiltinImport:off - macOS-only maintainer command; no application runtime dependencies.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { installBundle, restoreInstallation, LocalInstallError } from "./lib/local-mac-install.ts";
import { readPreparedBundle, run, writeReceipt } from "./lib/local-mac-artifact.ts";

const HELP = `Local Mac fork (Apple Silicon, Node 24, vp):
  node scripts/local-mac.ts prepare --output-dir /absolute/new/build-directory
  node scripts/local-mac.ts install --receipt /path/local-mac-receipt.json --backup /absolute/new/backup
  node scripts/local-mac.ts restore --backup /path/to/previous/backup

prepare builds the current clean checkout; it never fetches or merges upstream.
install/restore require T3 and its server to be stopped and never launch or kill apps.
Default data: ~/.t3; application: ~/Applications/T3 Code (Forgejo).app.
For isolated QA only: --home /tmp/... --applications-dir /tmp/...
Backups contain conversations, settings and credentials. Keep them private.
`;

const decodePackage = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }));

function main() {
  const { positionals, values } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "output-dir": { type: "string" },
      receipt: { type: "string" },
      backup: { type: "string" },
      home: { type: "string" },
      "applications-dir": { type: "string" },
    },
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }
  if (
    Effect.runSync(HostProcessPlatform) !== "darwin" ||
    Effect.runSync(HostProcessArchitecture) !== "arm64"
  )
    throw new LocalInstallError("This command supports macOS Apple Silicon only.");
  if (positionals.length !== 1) throw new LocalInstallError("Expected one command. Use --help.");
  const required = (name: "output-dir" | "receipt" | "backup") => {
    const value = values[name];
    if (!value) throw new LocalInstallError(`Missing --${name}`);
    return NodePath.resolve(value);
  };
  const support = NodePath.resolve(
    values.home
      ? NodePath.join(NodePath.resolve(values.home), "electron-profiles")
      : NodePath.join(NodeOS.homedir(), "Library", "Application Support"),
  );
  const paths = {
    home: NodePath.resolve(values.home ?? NodePath.join(NodeOS.homedir(), ".t3")),
    applications: NodePath.resolve(
      values["applications-dir"] ?? NodePath.join(NodeOS.homedir(), "Applications"),
    ),
    profiles: [NodePath.join(support, "T3 Code (Alpha)"), NodePath.join(support, "t3code")],
  };
  switch (positionals[0]) {
    case "prepare": {
      const repo = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
      process.chdir(repo);
      if (run("git", ["status", "--porcelain"]))
        throw new LocalInstallError(
          "Commit or otherwise preserve your changes before preparing a build; the checkout must be clean.",
        );
      const commit = run("git", ["rev-parse", "HEAD"]);
      const pkg = decodePackage(
        JSON.parse(NodeFS.readFileSync("apps/desktop/package.json", "utf8")),
      );
      const base = /^\d+\.\d+\.\d+/.exec(pkg.version)?.[0];
      if (!base) throw new LocalInstallError("Invalid desktop package version.");
      const version = `${base}-forgejo-local.${Effect.runSync(Clock.currentTimeMillis)}.g${commit.slice(0, 12)}`;
      const output = required("output-dir");
      NodeFS.mkdirSync(output, { mode: 0o700 });
      run(
        "vp",
        [
          "test",
          "run",
          "scripts/lib/local-mac-install.test.ts",
          "scripts/lib/local-mac-artifact.test.ts",
          "scripts/build-local-fork.test.ts",
          "apps/desktop/src/updates/localForkUpdates.test.ts",
          "apps/desktop/src/app/DesktopEnvironment.test.ts",
          "apps/desktop/src/app/DesktopAppIdentity.test.ts",
        ],
        true,
      );
      run(
        "vp",
        ["run", "--filter", "@t3tools/scripts", "--filter", "@t3tools/desktop", "typecheck"],
        true,
      );
      process.env.T3CODE_DESKTOP_SIGNED = "false";
      process.env.T3CODE_DESKTOP_SKIP_BUILD = "false";
      process.env.T3CODE_DESKTOP_MOCK_UPDATES = "false";
      const sdk = run("/usr/bin/xcrun", ["--show-sdk-path"]);
      // Recent Command Line Tools keep libc++ headers in the SDK, outside clang's default search path.
      process.env.CXXFLAGS =
        `${process.env.CXXFLAGS ?? ""} -isystem "${sdk}/usr/include/c++/v1"`.trim();
      run(
        process.execPath,
        [
          "scripts/build-desktop-artifact.ts",
          "--platform",
          "mac",
          "--arch",
          "arm64",
          "--target",
          "zip",
          "--build-version",
          version,
          "--output-dir",
          output,
        ],
        true,
      );
      if (run("git", ["rev-parse", "HEAD"]) !== commit || run("git", ["status", "--porcelain"]))
        throw new LocalInstallError(
          "Source changed during preparation; build has no install receipt.",
        );
      process.stdout.write(
        `Prepared: ${writeReceipt(output, version, commit)}\nQuit T3 before running install. No app or data was changed.`,
      );
      return;
    }
    case "install": {
      const backup = required("backup");
      const receipt = required("receipt");
      const bundle = readPreparedBundle(receipt, NodePath.dirname(receipt));
      const installed = installBundle({ paths, backup, bundle });
      process.stdout.write(
        `Installed: ${installed}\nBackup: ${backup}\nLaunch the fork yourself after confirming the official app and server are stopped. ${values.home ? `For isolated QA launch with T3CODE_HOME=${paths.home}.` : "Launch without T3CODE_HOME to reuse the existing Electron profile."}`,
      );
      return;
    }
    case "restore": {
      const preserved = restoreInstallation({ paths, backup: required("backup") });
      process.stdout.write(
        `Restored the pre-install data and prior fork, if any. Newer data preserved at: ${preserved}\nNo application was launched.`,
      );
      return;
    }
    default:
      throw new LocalInstallError("Unknown command. Use --help.");
  }
}
try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
