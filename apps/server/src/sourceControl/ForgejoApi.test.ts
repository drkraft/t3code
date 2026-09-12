import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as TestClock from "effect/testing/TestClock";

import { ForgejoApi } from "./ForgejoApi.ts";
import { harness } from "./ForgejoApi.testSupport.ts";

const viewer = Schema.Struct({ id: Schema.Number, login: Schema.String });
it.effect("decodes the viewer and isolates credentials for identical paths on two hosts", () => {
  const { layer, execute } = harness((request) =>
    Response.json({
      id: request.url.includes("other.example") ? 2 : 1,
      login: "operator",
    }),
  );
  return Effect.gen(function* () {
    const api = yield* ForgejoApi;
    const results = yield* Effect.all([
      api.getViewer("forge.example"),
      api.getViewer("other.example"),
    ]);
    assert.deepStrictEqual(results, [
      { id: 1, login: "operator" },
      { id: 2, login: "operator" },
    ]);
    assert.deepStrictEqual(
      execute.mock.calls.map(([request]) => [request.url, request.headers.authorization]),
      [
        ["https://forge.example/api/v1/user", "token first-secret"],
        ["https://other.example/api/v1/user", "token second-secret"],
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("resolves SSH aliases with their explicit port", () => {
  const { layer, execute } = harness(() => Response.json({ id: 1, login: "operator" }));
  return Effect.gen(function* () {
    const api = yield* ForgejoApi;
    const result = yield* api.getViewer("ssh://git@git.example:2222/team/repo.git");
    assert.strictEqual(result.login, "operator");
    assert.strictEqual(execute.mock.calls[0]?.[0].url, "https://forge.example/api/v1/user");
    assert.strictEqual(api.resolveConnection("git.example"), null);
  }).pipe(Effect.provide(layer));
});

for (const host of ["unconfigured.example", "forge.example"]) {
  it.effect(`sends no request when ${host} has no configured credential`, () => {
    const { layer, execute } = harness(() => Response.json({}), {});
    return Effect.gen(function* () {
      const api = yield* ForgejoApi;
      const error = yield* api.getViewer(host).pipe(Effect.flip);
      assert.include(["configuration", "unauthenticated"], error.reason);
      assert.strictEqual(execute.mock.calls.length, 0);
    }).pipe(Effect.provide(layer));
  });
}

for (const path of [
  "https://foreign.example/api/v1/user?token=hidden",
  "//foreign.example/api/v1/user",
]) {
  it.effect(
    `rejects an untrusted request URL before sending credentials: ${path.split("?")[0]}`,
    () => {
      const { layer, execute } = harness(() => Response.json({}));
      return Effect.gen(function* () {
        const api = yield* ForgejoApi;
        const error = yield* api
          .request({ host: "forge.example", path, schema: viewer })
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "invalid-url");
        assert.notInclude(error.detail, "hidden");
        assert.strictEqual(execute.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    },
  );
}

it.effect("refuses to forward credentials through a foreign redirect", () => {
  const { layer, execute } = harness(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://foreign.example/api/v1/user" },
      }),
  );
  return Effect.gen(function* () {
    const api = yield* ForgejoApi;
    const error = yield* api.getViewer("forge.example").pipe(Effect.flip);
    assert.strictEqual(error.reason, "invalid-url");
    assert.strictEqual(execute.mock.calls.length, 1);
  }).pipe(Effect.provide(layer));
});

for (const relative of [false, true]) {
  it.effect(
    `decodes a page and follows its ${relative ? "relative" : "absolute"} next link`,
    () => {
      const next = "https://forge.example/api/v1/users?page=2";
      const { layer, execute } = harness((request) =>
        Response.json([{ id: 1, login: "operator" }], {
          headers:
            request.url === next
              ? {}
              : { link: `<${relative ? "?page=2" : next}>; rel="next", <${next}>; rel="last"` },
        }),
      );
      return Effect.gen(function* () {
        const api = yield* ForgejoApi;
        const first = yield* api.page({ host: "forge.example", path: "/users", schema: viewer });
        assert.strictEqual(first.next, next);
        assert.deepStrictEqual(first.items, [{ id: 1, login: "operator" }]);
        assert.ok(first.next);
        const second = yield* api.page({ host: "forge.example", path: first.next, schema: viewer });
        assert.strictEqual(second.next, null);
        assert.strictEqual(execute.mock.calls.length, 2);
      }).pipe(Effect.provide(layer));
    },
  );
}

it.effect("rejects foreign pagination links before another request", () => {
  const { layer, execute } = harness(() =>
    Response.json([], {
      headers: { link: '<https://foreign.example/api/v1/users>; rel="next"' },
    }),
  );
  return Effect.gen(function* () {
    const api = yield* ForgejoApi;
    const error = yield* api
      .page({ host: "forge.example", path: "/users", schema: viewer })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "invalid-url");
    assert.strictEqual(execute.mock.calls.length, 1);
  }).pipe(Effect.provide(layer));
});

for (const body of ["not JSON first-secret", '{"id":"wrong-type","login":"operator"}']) {
  it.effect(
    `rejects invalid response data (${body.startsWith("{") ? "schema" : "JSON"}) without exposing it`,
    () => {
      const { layer } = harness(() => new Response(body));
      return Effect.gen(function* () {
        const api = yield* ForgejoApi;
        const error = yield* api.getViewer("forge.example").pipe(Effect.flip);
        assert.strictEqual(error.reason, "invalid-response");
        assert.notInclude(error.detail, "first-secret");
        assert.notInclude(error.detail, "wrong-type");
      }).pipe(Effect.provide(layer));
    },
  );
}

for (const [status, reason] of [
  [401, "unauthenticated"],
  [403, "forbidden"],
  [404, "not-found"],
  [429, "rate-limited"],
] as const) {
  it.effect(`maps HTTP ${status} to ${reason} without exposing response content`, () => {
    const { layer } = harness(
      () => new Response("first-secret", { status, headers: { "Retry-After": "120" } }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const api = yield* ForgejoApi;
      const error = yield* api.getViewer("forge.example").pipe(Effect.flip);
      assert.strictEqual(error.reason, reason);
      assert.strictEqual(error.status, status);
      assert.notInclude(error.detail, "first-secret");
      if (status === 429) assert.strictEqual(error.retryAt, 121_000);
    }).pipe(Effect.provide(layer));
  });
}

it.effect("rejects a response above the 8 MiB limit", () => {
  const { layer } = harness(() => Response.json({ id: 1, login: "x".repeat(8 * 1024 * 1024) }));
  return Effect.gen(function* () {
    const api = yield* ForgejoApi;
    const error = yield* api.getViewer("forge.example").pipe(Effect.flip);
    assert.strictEqual(error.reason, "invalid-response");
  }).pipe(Effect.provide(layer));
});

it.effect("does not retry a failed mutation", () => {
  const { layer, execute } = harness(() => new Response("service unavailable", { status: 503 }));
  return Effect.gen(function* () {
    const api = yield* ForgejoApi;
    const error = yield* api
      .request({
        host: "forge.example",
        path: "/repos/team/repo/issues",
        method: "POST",
        body: '{"title":"test"}',
        schema: viewer,
      })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "failed");
    assert.strictEqual(execute.mock.calls.length, 1);
    assert.strictEqual(execute.mock.calls[0]?.[0].method, "POST");
  }).pipe(Effect.provide(layer));
});

it.effect("returns a bounded raw patch without changing JSON decoding", () => {
  const { layer, execute } = harness(() => new Response("x".repeat(8 * 1024 * 1024 + 1)));
  return Effect.gen(function* () {
    const api = yield* ForgejoApi;
    const result = yield* api.requestText({
      host: "forge.example",
      path: "/repos/a/b/pulls/1.diff",
    });
    assert.strictEqual(result.text.length, 8 * 1024 * 1024);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.invalidUtf8, false);
    assert.strictEqual(execute.mock.calls[0]?.[0].headers.accept, "text/plain");
  }).pipe(Effect.provide(layer));
});

it.effect("preserves a next link for explicitly nullable empty pages", () => {
  const { layer } = harness(() =>
    Response.json(null, { headers: { link: '<?page=2>; rel="next"' } }),
  );
  return Effect.gen(function* () {
    const api = yield* ForgejoApi;
    const result = yield* api.page({
      host: "forge.example",
      path: "/reactions",
      schema: viewer,
      allowNullItems: true,
    });
    assert.deepStrictEqual(result, {
      items: [],
      next: "https://forge.example/api/v1/reactions?page=2",
    });
    const strict = yield* api
      .page({ host: "forge.example", path: "/reactions", schema: viewer })
      .pipe(Effect.flip);
    assert.strictEqual(strict.reason, "invalid-response");
  }).pipe(Effect.provide(layer));
});
