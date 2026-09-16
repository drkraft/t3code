import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ForgejoApi from "./ForgejoApi.ts";

function layer(ids: readonly string[]) {
  return ForgejoApi.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url.includes("broken")
                ? new Response(null, { status: 401 })
                : Response.json({ id: 1, login: "viewer" }),
            ),
          ),
        ),
      ),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_FORGEJO_CONNECTIONS: JSON.stringify(
              ids.map((id) => ({
                id,
                apiUrl: `https://${id}.example/api/v1`,
                gitHosts: [],
                tokenEnv: "TEST_TOKEN",
              })),
            ),
            TEST_TOKEN: "test-secret",
          },
        }),
      ),
    ),
  );
}

it.effect("shows the authenticated account and host for a single connection", () =>
  Effect.gen(function* () {
    const api = yield* ForgejoApi.ForgejoApi;
    const auth = yield* api.probeAuth;
    assert.deepEqual(auth.account, Option.some("viewer"));
    assert.deepEqual(auth.host, Option.some("one.example"));
  }).pipe(Effect.provide(layer(["one"]))),
);

it.effect("keeps a working instance authenticated when another account fails", () =>
  Effect.gen(function* () {
    const api = yield* ForgejoApi.ForgejoApi;
    const auth = yield* api.probeAuth;
    assert.strictEqual(auth.status, "authenticated");
    assert.deepEqual(auth.account, Option.none());
    assert.deepEqual(auth.host, Option.none());
    assert.notInclude(
      Option.getOrElse(auth.detail, () => ""),
      "test-secret",
    );
  }).pipe(Effect.provide(layer(["one", "broken"]))),
);
