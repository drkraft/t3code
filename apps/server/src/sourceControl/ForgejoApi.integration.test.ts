// @effect-diagnostics-next-line nodeBuiltinImport:off - A real HTTP peer independently verifies the Effect client's wire behavior.
import * as NodeHttp from "node:http";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { ForgejoApi, layer as forgejoLayer } from "./ForgejoApi.ts";

const startServer = Effect.fn("ForgejoApiTest.startServer")(function* (
  handler: NodeHttp.RequestListener,
) {
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => NodeHttp.createServer(handler)),
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
  return `http://127.0.0.1:${address.port}`;
});

function liveLayer(origin: string) {
  return forgejoLayer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_FORGEJO_CONNECTIONS: JSON.stringify([
              { id: "local", apiUrl: `${origin}/api/v1`, gitHosts: [], tokenEnv: "LOCAL_TOKEN" },
            ]),
            LOCAL_TOKEN: "integration-test-token",
          },
        }),
      ),
    ),
  );
}

it.effect("authenticates real HTTP requests and follows validated pagination", () =>
  Effect.gen(function* () {
    const paths: Array<string | undefined> = [];
    const origin = yield* startServer((request, response) => {
      paths.push(request.url);
      if (request.headers.authorization !== "token integration-test-token") {
        response.writeHead(401).end();
        return;
      }
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/v1/user") {
        response.end(JSON.stringify({ id: 42, login: "local-operator" }));
        return;
      }
      if (request.url === "/api/v1/users") {
        response.setHeader(
          "link",
          `<http://${request.headers.host}/api/v1/users?page=2>; rel="next"`,
        );
        response.end(JSON.stringify([{ id: 1 }]));
        return;
      }
      response.end(JSON.stringify([{ id: 2 }]));
    });
    const result = yield* Effect.gen(function* () {
      const api = yield* ForgejoApi;
      const viewer = yield* api.getViewer(origin);
      const first = yield* api.page({
        host: origin,
        path: "/users",
        schema: Schema.Struct({ id: Schema.Int }),
      });
      assert.ok(first.next);
      const second = yield* api.page({
        host: origin,
        path: first.next,
        schema: Schema.Struct({ id: Schema.Int }),
      });
      return { viewer, first: first.items, second: second.items, next: second.next };
    }).pipe(Effect.provide(liveLayer(origin)));
    assert.deepEqual(result, {
      viewer: { id: 42, login: "local-operator" },
      first: [{ id: 1 }],
      second: [{ id: 2 }],
      next: null,
    });
    assert.deepEqual(paths, ["/api/v1/user", "/api/v1/users", "/api/v1/users?page=2"]);
  }).pipe(Effect.scoped),
);

it.effect("does not let real fetch follow a redirect to another origin", () =>
  Effect.gen(function* () {
    let redirectedRequests = 0;
    let authenticatedRequests = 0;
    const destination = yield* startServer((_request, response) => {
      redirectedRequests += 1;
      response.end(JSON.stringify({ id: 99, login: "redirect-target" }));
    });
    const origin = yield* startServer((request, response) => {
      if (request.headers.authorization === "token integration-test-token")
        authenticatedRequests += 1;
      response.writeHead(302, { location: `${destination}/api/v1/user` }).end();
    });
    const error = yield* Effect.gen(function* () {
      const api = yield* ForgejoApi;
      return yield* api.getViewer(origin).pipe(Effect.flip);
    }).pipe(Effect.provide(liveLayer(origin)));
    assert.equal(error.reason, "invalid-url");
    assert.equal(authenticatedRequests, 1);
    assert.equal(redirectedRequests, 0);
  }).pipe(Effect.scoped),
);
