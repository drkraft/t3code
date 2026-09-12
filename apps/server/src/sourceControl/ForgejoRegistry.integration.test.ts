// @effect-diagnostics-next-line nodeBuiltinImport:off - The registry is exercised against an independent real HTTP peer.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, DateTime, Effect, Layer, Option, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as BitbucketApi from "./BitbucketApi.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitLabCli from "./GitLabCli.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const freshness = {
  source: "live-local" as const,
  observedAt: DateTime.makeUnsafe("2026-09-12T00:00:00Z"),
  expiresAt: Option.none(),
};

const startPeer = Effect.fn("ForgejoRegistryTest.startPeer")(function* (branch: string) {
  const requests: Array<{ path: string | undefined; authorization: string | undefined }> = [];
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeHttp.createServer((request, response) => {
        requests.push({ path: request.url, authorization: request.headers.authorization });
        response.setHeader("content-type", "application/json");
        response.end(
          encodeJson({
            id: 1,
            name: "project",
            full_name: "team/project",
            owner: { login: "team" },
            default_branch: branch,
            clone_url: "https://git.example/team/project.git",
            ssh_url: "git@git.example:team/project.git",
            html_url: "https://git.example/team/project",
            private: true,
            empty: false,
          }),
        );
      }),
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            if (!server.listening) {
              resolve();
              return;
            }
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      ),
  );
  yield* Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { apiUrl: `http://127.0.0.1:${address.port}/api/v1`, requests };
});

const makeRegistry = Effect.fn("ForgejoRegistryTest.makeRegistry")(function* (
  connections: readonly {
    id: string;
    apiUrl: string;
    gitHosts: readonly string[];
    tokenEnv: string;
  }[],
) {
  const driver = yield* VcsDriver.VcsDriver.pipe(
    Effect.provide(
      Layer.mock(VcsDriver.VcsDriver)({
        capabilities: {
          kind: "git",
          supportsWorktrees: true,
          supportsBookmarks: false,
          supportsAtomicSnapshot: false,
          supportsPushDefaultRemote: true,
          ignoreClassifier: "native",
        },
        listRemotes: (cwd) =>
          Effect.succeed({
            remotes: [
              {
                name: "origin",
                url: `ssh://git@${cwd === "/second" ? "second-ssh:2222" : "first-ssh:2222"}/team/project.git`,
                pushUrl: Option.none(),
                isPrimary: true,
              },
            ],
            freshness,
          }),
      }),
    ),
  );
  return yield* SourceControlProviderRegistry.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          get: () => Effect.succeed(driver),
          resolve: ({ cwd }) =>
            Effect.succeed({
              kind: "git",
              repository: { kind: "git", rootPath: cwd, metadataPath: null, freshness },
              driver,
            }),
        }),
        Layer.mock(VcsProcess.VcsProcess)({
          run: () =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}),
        Layer.mock(BitbucketApi.BitbucketApi)({}),
        Layer.mock(GitHubCli.GitHubCli)({}),
        Layer.mock(GitLabCli.GitLabCli)({}),
        NodeServices.layer,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-forgejo-registry-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              T3CODE_FORGEJO_CONNECTIONS: encodeJson(connections),
              FIRST_TOKEN: "first-test-token",
              SECOND_TOKEN: "second-test-token",
            },
          }),
        ),
      ),
    ),
  );
});

it.effect("reads each cwd repository through its configured SSH alias and account", () =>
  Effect.gen(function* () {
    const first = yield* startPeer("trunk-first");
    const second = yield* startPeer("trunk-second");
    const registry = yield* makeRegistry([
      { id: "first", apiUrl: first.apiUrl, gitHosts: ["first-ssh:2222"], tokenEnv: "FIRST_TOKEN" },
      {
        id: "second",
        apiUrl: second.apiUrl,
        gitHosts: ["second-ssh:2222"],
        tokenEnv: "SECOND_TOKEN",
      },
    ]);

    const branches = yield* Effect.forEach(
      ["/first", "/second"],
      Effect.fn(function* (cwd) {
        const provider = yield* registry.resolve({ cwd });
        return yield* provider.getDefaultBranch({ cwd });
      }),
    );

    assert.deepEqual(branches, ["trunk-first", "trunk-second"]);
    assert.deepEqual(first.requests, [
      { path: "/api/v1/repos/team/project", authorization: "token first-test-token" },
    ]);
    assert.deepEqual(second.requests, [
      { path: "/api/v1/repos/team/project", authorization: "token second-test-token" },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("rejects an unconfigured repository host before contacting a configured instance", () =>
  Effect.gen(function* () {
    const peer = yield* startPeer("trunk");
    const registry = yield* makeRegistry([
      { id: "first", apiUrl: peer.apiUrl, gitHosts: ["first-ssh:2222"], tokenEnv: "FIRST_TOKEN" },
    ]);
    const provider = yield* registry.get("forgejo");

    const error = yield* provider
      .getRepositoryCloneUrls({
        cwd: "/first",
        repository: "https://unconfigured.example/team/project",
      })
      .pipe(Effect.flip);

    assert.equal(error.provider, "forgejo");
    assert.equal(error.operation, "getRepositoryCloneUrls");
    assert.deepEqual(peer.requests, []);
  }).pipe(Effect.scoped),
);
