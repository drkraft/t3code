import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as SafeStorage from "../electron/ElectronSafeStorage.ts";
import * as Store from "./DesktopForgejoConnections.ts";

const connection = {
  id: "home",
  apiUrl: "https://forge.example/api/v1",
  gitHosts: [],
  token: "synthetic-private-token",
};
const boundary = (options: { available?: boolean; decryptError?: boolean } = {}) =>
  Layer.succeed(SafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(options.available ?? true),
    encryptString: (value) =>
      Effect.succeed(new TextEncoder().encode([...value].toReversed().join(""))),
    decryptString: (value) =>
      options.decryptError
        ? Effect.fail(
            new SafeStorage.ElectronSafeStorageDecryptError({ cause: new Error(connection.token) }),
          )
        : Effect.succeed([...new TextDecoder().decode(value)].toReversed().join("")),
    selectedStorageBackend: Effect.succeed(Option.none()),
  });
const test = <A, E>(
  program: Effect.Effect<
    A,
    E,
    Store.DesktopForgejoConnections | DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem
  >,
  options: {
    external?: string;
    platform?: NodeJS.Platform;
    available?: boolean;
    decryptError?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-forgejo-store-" });
    const config = DesktopConfig.layerTest({
      T3CODE_HOME: root,
      T3CODE_FORGEJO_CONNECTIONS: options.external,
    });
    const environment = DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/src",
      homeDirectory: root,
      platform: options.platform ?? "darwin",
      processArch: "arm64",
      appVersion: "1.2.3",
      appPath: "/repo",
      isPackaged: true,
      resourcesPath: "/missing",
      runningUnderArm64Translation: false,
    }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, config)));
    return yield* program.pipe(
      Effect.provide(
        Store.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(environment, NodeServices.layer, boundary(options))),
          Layer.provide(config),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("saves encrypted data with private permissions and only returns metadata", () =>
  test(
    Effect.gen(function* () {
      const store = yield* Store.DesktopForgejoConnections;
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const state = yield* store.upsert(connection);
      assert.equal(state.pendingRestart, true);
      assert.equal(state.connections[0]?.hasToken, true);
      assert.notInclude(NodeUtil.inspect(state), connection.token);
      assert.notInclude(NodeUtil.inspect(state), "encryptedToken");
      assert.notInclude(
        yield* fs.readFileString(environment.forgejoRegistryPath),
        connection.token,
      );
      assert.equal((yield* fs.stat(environment.forgejoRegistryPath)).mode & 0o777, 0o600);
      assert.deepEqual(yield* store.loadForBootstrap, [connection]);
      assert.equal((yield* store.get).pendingRestart, false);
    }),
  ),
);

it.effect("preserves token on metadata edits and detects token-only replacements", () =>
  test(
    Effect.gen(function* () {
      const store = yield* Store.DesktopForgejoConnections;
      yield* store.upsert(connection);
      yield* store.loadForBootstrap;
      const replacement = yield* store.upsert({ ...connection, token: "replacement-token" });
      assert.equal(replacement.pendingRestart, true);
      assert.deepEqual(replacement.activeConnectionIds, ["home"]);
      yield* store.upsert({
        id: connection.id,
        apiUrl: connection.apiUrl,
        gitHosts: ["git.example:2222"],
      });
      assert.deepEqual(yield* store.loadForBootstrap, [
        { ...connection, token: "replacement-token", gitHosts: ["git.example:2222"] },
      ]);
    }),
  ),
);

it.effect("requires a new token when API origin changes and preserves the previous file", () =>
  test(
    Effect.gen(function* () {
      const store = yield* Store.DesktopForgejoConnections;
      const fs = yield* FileSystem.FileSystem;
      const { forgejoRegistryPath } = yield* DesktopEnvironment.DesktopEnvironment;
      yield* store.upsert(connection);
      const before = yield* fs.readFileString(forgejoRegistryPath);
      yield* Effect.flip(
        store.upsert({ id: "home", apiUrl: "https://other.example/api/v1", gitHosts: [] }),
      );
      assert.equal(yield* fs.readFileString(forgejoRegistryPath), before);
    }),
  ),
);

it.effect("serializes concurrent additions and removes only the chosen connection", () =>
  test(
    Effect.gen(function* () {
      const store = yield* Store.DesktopForgejoConnections;
      yield* Effect.all(
        [
          store.upsert(connection),
          store.upsert({ ...connection, id: "work", apiUrl: "https://work.example/api/v1" }),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal((yield* store.get).connections.length, 2);
      const remaining = yield* store.remove("home");
      assert.deepEqual(
        remaining.connections.map((entry) => entry.id),
        ["work"],
      );
    }),
  ),
);

it.effect("rejects aliases shared by connections without overwriting", () =>
  test(
    Effect.gen(function* () {
      const store = yield* Store.DesktopForgejoConnections;
      yield* store.upsert(connection);
      yield* Effect.flip(
        store.upsert({
          ...connection,
          id: "other",
          apiUrl: "https://other.example/api/v1",
          gitHosts: ["forge.example"],
        }),
      );
      assert.equal((yield* store.get).connections.length, 1);
    }),
  ),
);

for (const raw of ["{broken", '{"version":2,"revision":"x","connections":[]}']) {
  it.effect(`preserves unreadable registry ${raw.slice(0, 12)} and keeps startup alive`, () =>
    test(
      Effect.gen(function* () {
        const store = yield* Store.DesktopForgejoConnections;
        const fs = yield* FileSystem.FileSystem;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        yield* fs.makeDirectory(environment.stateDir, { recursive: true });
        yield* fs.writeFileString(environment.forgejoRegistryPath, raw);
        assert.deepEqual(yield* store.loadForBootstrap, []);
        assert.isString((yield* store.get).error);
        yield* Effect.flip(store.upsert(connection));
        assert.equal(yield* fs.readFileString(environment.forgejoRegistryPath), raw);
      }),
    ),
  );
}
for (const external of ["[]", "invalid", ""]) {
  it.effect(`honors explicit external configuration ${NodeUtil.inspect(external)}`, () =>
    test(
      Effect.gen(function* () {
        const store = yield* Store.DesktopForgejoConnections;
        assert.equal((yield* store.get).source, "external");
        assert.equal(yield* store.loadForBootstrap, undefined);
        yield* Effect.flip(store.upsert(connection));
      }),
      { external },
    ),
  );
}
it.effect("does not write when native encryption is unavailable", () =>
  test(
    Effect.gen(function* () {
      const store = yield* Store.DesktopForgejoConnections;
      const fs = yield* FileSystem.FileSystem;
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      yield* Effect.flip(store.upsert(connection));
      assert.equal(yield* fs.exists(environment.forgejoRegistryPath), false);
    }),
    { available: false },
  ),
);
it.effect("strips secret-bearing decryption causes and preserves data", () =>
  test(
    Effect.gen(function* () {
      const store = yield* Store.DesktopForgejoConnections;
      yield* store.upsert(connection);
      assert.deepEqual(yield* store.loadForBootstrap, []);
      const error = yield* Effect.flip(store.remove(connection.id));
      assert.notInclude(NodeUtil.inspect(error), connection.token);
      assert.notInclude(NodeUtil.inspect(yield* store.get), connection.token);
      assert.equal((yield* store.get).connections.length, 1);
    }),
    { decryptError: true },
  ),
);
it.effect("does not touch local secrets on unsupported platforms", () =>
  test(
    Effect.gen(function* () {
      const store = yield* Store.DesktopForgejoConnections;
      assert.equal((yield* store.get).source, "unsupported");
      assert.equal(yield* store.loadForBootstrap, undefined);
      yield* Effect.flip(store.upsert(connection));
    }),
    { platform: "linux" },
  ),
);

it.effect("preserves the previous registry when the directory becomes unwritable", () =>
  test(
    Effect.gen(function* () {
      const store = yield* Store.DesktopForgejoConnections;
      const fs = yield* FileSystem.FileSystem;
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      yield* store.upsert(connection);
      const previous = yield* fs.readFileString(environment.forgejoRegistryPath);
      yield* fs.chmod(environment.stateDir, 0o500);
      yield* Effect.flip(store.upsert({ ...connection, token: "replacement" })).pipe(
        Effect.ensuring(fs.chmod(environment.stateDir, 0o700).pipe(Effect.orDie)),
      );
      assert.equal(yield* fs.readFileString(environment.forgejoRegistryPath), previous);
    }),
  ),
);
