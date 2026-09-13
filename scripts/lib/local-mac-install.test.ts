// @effect-diagnostics nodeBuiltinImport:off - Tests exercise real filesystem and macOS tools.
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { installBundle, restoreInstallation, assertStopped } from "./local-mac-install.ts";

const roots: string[] = [];
function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-local-install-test-"));
  roots.push(root);
  const paths = {
    home: NodePath.join(root, "home"),
    applications: NodePath.join(root, "Applications"),
    profiles: [NodePath.join(root, "profile")],
  };
  NodeFS.mkdirSync(NodePath.join(paths.home, "userdata"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(root, "profile"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(paths.home, "userdata", "state.sqlite"), "old conversations");
  NodeFS.writeFileSync(
    NodePath.join(NodePath.join(root, "profile"), "settings"),
    "old preferences",
  );
  const bundle = NodePath.join(root, "source.app");
  NodeFS.mkdirSync(bundle);
  NodeFS.writeFileSync(NodePath.join(bundle, "version"), "new");
  return { root, paths, bundle, backup: NodePath.join(root, "backup") };
}
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("local Mac install", () => {
  it("backs up stopped data and retains the old fork when replacing a bundle", () => {
    const f = fixture();
    NodeFS.mkdirSync(NodePath.join(f.paths.applications, "T3 Code (Forgejo).app"), {
      recursive: true,
    });
    NodeFS.writeFileSync(
      NodePath.join(f.paths.applications, "T3 Code (Forgejo).app", "version"),
      "old",
    );
    installBundle({ ...f, checkStopped: () => {} });
    expect(NodeFS.readFileSync(NodePath.join(f.backup, "userdata", "state.sqlite"), "utf8")).toBe(
      "old conversations",
    );
    expect(NodeFS.readFileSync(NodePath.join(f.backup, "previous.app", "version"), "utf8")).toBe(
      "old",
    );
    expect(
      NodeFS.readFileSync(
        NodePath.join(f.paths.applications, "T3 Code (Forgejo).app", "version"),
        "utf8",
      ),
    ).toBe("new");
  });
  it("restores old data and preserves newer data for recovery", () => {
    const f = fixture();
    installBundle({ ...f, checkStopped: () => {} });
    NodeFS.writeFileSync(
      NodePath.join(f.paths.home, "userdata", "state.sqlite"),
      "new conversations",
    );
    const preserved = restoreInstallation({
      paths: f.paths,
      backup: f.backup,
      checkStopped: () => {},
    });
    expect(
      NodeFS.readFileSync(NodePath.join(f.paths.home, "userdata", "state.sqlite"), "utf8"),
    ).toBe("old conversations");
    expect(NodeFS.readFileSync(NodePath.join(preserved, "userdata", "state.sqlite"), "utf8")).toBe(
      "new conversations",
    );
    expect(NodeFS.existsSync(NodePath.join(f.paths.applications, "T3 Code (Forgejo).app"))).toBe(
      false,
    );
  });
  it("refuses collisions without changing existing files", () => {
    const f = fixture();
    NodeFS.mkdirSync(f.backup);
    expect(() => installBundle({ ...f, checkStopped: () => {} })).toThrow();
    expect(
      NodeFS.readFileSync(NodePath.join(f.paths.home, "userdata", "state.sqlite"), "utf8"),
    ).toBe("old conversations");
  });
  it("refuses concurrent installer operations", () => {
    const f = fixture();
    NodeFS.mkdirSync(NodePath.join(f.paths.applications, ".t3-forgejo-install.lock"), {
      recursive: true,
    });
    expect(() => installBundle({ ...f, checkStopped: () => {} })).toThrow();
    expect(NodeFS.existsSync(f.backup)).toBe(false);
  });
  it("preserves the active installation when a backup cannot be staged for restore", () => {
    const f = fixture();
    installBundle({ ...f, checkStopped: () => {} });
    NodeFS.writeFileSync(
      NodePath.join(f.paths.home, "userdata", "state.sqlite"),
      "new conversations",
    );
    NodeFS.rmSync(NodePath.join(f.backup, "userdata"), { recursive: true });
    expect(() => restoreInstallation({ ...f, checkStopped: () => {} })).toThrow();
    expect(
      NodeFS.readFileSync(NodePath.join(f.paths.home, "userdata", "state.sqlite"), "utf8"),
    ).toBe("new conversations");
    expect(
      NodeFS.readFileSync(
        NodePath.join(f.paths.applications, "T3 Code (Forgejo).app", "version"),
        "utf8",
      ),
    ).toBe("new");
  });
  it("rejects a backup nested through a symlink inside the data", () => {
    const f = fixture();
    const alias = NodePath.join(f.root, "alias");
    NodeFS.symlinkSync(NodePath.join(f.paths.home, "userdata"), alias);
    expect(() =>
      installBundle({ ...f, backup: NodePath.join(alias, "backup"), checkStopped: () => {} }),
    ).toThrow(/separate/);
    expect(NodeFS.existsSync(NodePath.join(alias, "backup"))).toBe(false);
  });
  it("leaves the old fork in place when T3 starts during backup", () => {
    const f = fixture();
    let checks = 0;
    expect(() =>
      installBundle({
        ...f,
        checkStopped: () => {
          if (++checks === 2) throw new Error("T3 started");
        },
      }),
    ).toThrow("T3 started");
    expect(NodeFS.existsSync(NodePath.join(f.paths.applications, "T3 Code (Forgejo).app"))).toBe(
      false,
    );
    expect(
      NodeFS.readFileSync(NodePath.join(f.paths.home, "userdata", "state.sqlite"), "utf8"),
    ).toBe("old conversations");
  });
  it.effect("refuses an open database", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) !== "darwin") return;
      const f = fixture();
      const fd = NodeFS.openSync(NodePath.join(f.paths.home, "userdata", "state.sqlite"), "r");
      try {
        expect(() => assertStopped(f.paths)).toThrow(/open/);
      } finally {
        NodeFS.closeSync(fd);
      }
    }),
  );
});
