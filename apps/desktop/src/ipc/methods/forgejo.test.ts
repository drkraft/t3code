import * as NodeUtil from "node:util";
import type { DesktopForgejoState } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Cause, Layer, Option } from "effect";
import { vi } from "vite-plus/test";
import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import type { DesktopBackendStartConfig } from "../../backend/DesktopBackendManager.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as Store from "../../settings/DesktopForgejoConnections.ts";
import {
  getForgejoConfiguration,
  saveForgejoConnection,
  removeForgejoConnection,
} from "./forgejo.ts";

vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = { id: 7 };
    isDestroyed() {
      return false;
    }
  },
}));

const config: DesktopBackendStartConfig = {
  executablePath: "/electron",
  entryPath: "/server",
  cwd: "/tmp",
  args: [],
  env: {},
  extendEnv: true,
  captureOutput: true,
  preflightFailure: Option.none(),
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  bootstrapDelivery: "fd3",
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/forgejo-ipc",
    host: "127.0.0.1",
    desktopBootstrapToken: "bootstrap",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
};
const state = {
  source: "local" as const,
  connections: [],
  activeConnectionIds: [],
  pendingRestart: false,
  error: null,
};
const connection = {
  id: "test",
  apiUrl: "https://forge.example/api/v1",
  gitHosts: ["forge.example"],
  token: "sensitive-test-token",
};
const request = { environmentUrl: "http://127.0.0.1:3773", connection, id: "test" };

const environmentLayer = (platform: NodeJS.Platform) =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: "/Users/test",
    platform,
    processArch: "arm64",
    appVersion: "0.0.40",
    appPath: "/app",
    isPackaged: true,
    resourcesPath: "/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({ T3CODE_HOME: "/tmp/forgejo-ipc" }),
      ),
    ),
  );

const testLayer = (
  calls: string[],
  current = Option.some(config),
  platform: NodeJS.Platform = "darwin",
  storeState: DesktopForgejoState = state,
) =>
  Layer.mergeAll(
    environmentLayer(platform),
    ElectronWindow.layer,
    DesktopBackendPool.layerTest([
      {
        id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
        label: Effect.succeed("Local"),
        start: Effect.void,
        stop: () => Effect.void,
        currentConfig: Effect.succeed(current),
        waitForReady: () => Effect.succeed(true),
        snapshot: Effect.succeed({
          desiredRunning: true,
          ready: true,
          activePid: Option.none(),
          restartAttempt: 0,
          restartScheduled: false,
        }),
      },
    ]),
    Layer.succeed(Store.DesktopForgejoConnections, {
      get: Effect.sync(() => {
        calls.push("get");
        return storeState;
      }),
      upsert: () =>
        Effect.sync(() => {
          calls.push("save");
          return storeState;
        }),
      remove: () =>
        Effect.sync(() => {
          calls.push("remove");
          return storeState;
        }),
      loadForBootstrap: Effect.succeed(undefined),
    }),
  );
const setMain = Effect.gen(function* () {
  const windows = yield* ElectronWindow.ElectronWindow;
  yield* windows.setMain(yield* windows.create({}));
});

describe("Forgejo desktop IPC", () => {
  it.effect(
    "allows metadata operations from the main renderer for the native local environment",
    () => {
      const calls: string[] = [];
      return Effect.gen(function* () {
        yield* setMain;
        for (const method of [
          getForgejoConfiguration,
          saveForgejoConnection,
          removeForgejoConnection,
        ]) {
          const result = yield* method.handler(request, { sender: { id: 7 } });
          assert.deepEqual(result, {
            ...state,
            connections: [
              {
                id: "test",
                apiUrl: "https://forge.example/api/v1",
                gitHosts: ["forge.example"],
                hasToken: true,
              },
            ],
          });
          assert.isFalse(NodeUtil.inspect(result, { depth: null }).includes(connection.token));
        }
        assert.deepEqual(calls, ["get", "save", "remove"]);
      }).pipe(
        Effect.provide(
          testLayer(calls, Option.some(config), "darwin", {
            ...state,
            connections: [{ ...connection, hasToken: true }],
          }),
        ),
      );
    },
  );

  for (const scenario of [
    { name: "other renderer", sender: 8 },
    { name: "remote environment", url: "https://remote.example" },
    { name: "invalid URL", url: "invalid" },
    { name: "unstarted backend", current: Option.none<DesktopBackendStartConfig>() },
    {
      name: "WSL backend",
      current: Option.some({ ...config, bootstrapDelivery: "stdin" as const }),
    },
    {
      name: "different home",
      current: Option.some({ ...config, bootstrap: { ...config.bootstrap, t3Home: "/other" } }),
    },
    { name: "non-Mac client", platform: "linux" as const },
  ]) {
    it.effect(`rejects all operations for ${scenario.name}`, () => {
      const calls: string[] = [];
      return Effect.gen(function* () {
        yield* setMain;
        for (const method of [
          getForgejoConfiguration,
          saveForgejoConnection,
          removeForgejoConnection,
        ]) {
          const result = yield* Effect.exit(
            method.handler(
              { ...request, environmentUrl: scenario.url ?? request.environmentUrl },
              { sender: { id: scenario.sender ?? 7 } },
            ),
          );
          assert(Exit.isFailure(result));
        }
        assert.deepEqual(calls, []);
      }).pipe(Effect.provide(testLayer(calls, scenario.current, scenario.platform)));
    });
  }

  it.effect("sanitizes invalid payload errors without retaining the secret", () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      yield* setMain;
      const result = yield* Effect.exit(
        saveForgejoConnection.handler(
          { ...request, connection: { ...connection, apiUrl: connection.token } },
          { sender: { id: 7 } },
        ),
      );
      assert(Exit.isFailure(result));
      assert.isFalse(Cause.pretty(result.cause).includes(connection.token));
      assert.isFalse(NodeUtil.inspect(result.cause, { depth: null }).includes(connection.token));
      assert.deepEqual(calls, []);
    }).pipe(Effect.provide(testLayer(calls)));
  });
  it.effect("sanitizes result encoding failures without retaining invalid values", () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      yield* setMain;
      const result = yield* Effect.exit(
        getForgejoConfiguration.handler(request, { sender: { id: 7 } }),
      );
      assert(Exit.isFailure(result));
      assert.isFalse(NodeUtil.inspect(result.cause, { depth: null }).includes(connection.token));
    }).pipe(
      Effect.provide(
        testLayer(calls, Option.some(config), "darwin", {
          ...state,
          connections: [{ ...connection, apiUrl: connection.token, hasToken: true }],
        }),
      ),
    );
  });

  it.effect("rejects absent sender and absent main window", () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      assert(
        Exit.isFailure(
          yield* Effect.exit(getForgejoConfiguration.handler(request, { sender: { id: 7 } })),
        ),
      );
      yield* setMain;
      assert(Exit.isFailure(yield* Effect.exit(saveForgejoConnection.handler(request))));
      assert.deepEqual(calls, []);
    }).pipe(Effect.provide(testLayer(calls)));
  });
});
