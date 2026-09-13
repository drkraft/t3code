import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Api from "../sourceControl/ForgejoApi.ts";
import { pullRequestFixture as pr } from "./forgejoPullRequestTestHarness.ts";
import { make } from "./ForgejoPullRequestPermissions.ts";

const input = { cwd: "/repo", host: "forge.example", repository: "org/repo", number: 1 };
const harness = (respond: (url: URL) => Response) =>
  Api.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url.includes("/branches/")
                ? Response.json({
                    protected: false,
                    user_can_merge: false,
                    user_can_push: false,
                    enable_status_check: false,
                    status_check_contexts: [],
                    required_approvals: 0,
                  })
                : respond(new URL(request.url)),
            ),
          ),
        ),
      ),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_FORGEJO_CONNECTIONS:
              '[{"id":"test","apiUrl":"https://forge.example/api/v1","gitHosts":[],"tokenEnv":"TEST_TOKEN"}]',
            TEST_TOKEN: "fixture",
          },
        }),
      ),
    ),
  );

it.effect("withholds approval and rejection when the viewer authored the pull request", () =>
  Effect.gen(function* () {
    const permissions = yield* make;
    const result = yield* permissions.getViewerPermissions(input);
    assert.deepStrictEqual(result.verdicts, ["comment"]);
    assert.isTrue(result.requestReviewers);
  }).pipe(
    Effect.provide(
      harness((url) =>
        Response.json(
          url.pathname.endsWith("/user")
            ? { id: 7, login: "renamed" }
            : url.pathname.endsWith("/pulls/1")
              ? { ...pr, user: { id: 7, login: "original" } }
              : { archived: false },
        ),
      ),
    ),
  ),
);

it.effect("preserves unknown PR-unit rights when code push is denied and the PR is locked", () =>
  Effect.gen(function* () {
    const permissions = yield* make;
    const result = yield* permissions.getViewerPermissions(input);
    assert.deepStrictEqual(result, {
      actions: ["close"],
      updateMethods: [],
      comment: true,
      resolve: false,
      verdicts: ["comment", "approve", "request-changes"],
      requestReviewers: true,
      labels: true,
    });
  }).pipe(
    Effect.provide(
      harness((url) =>
        Response.json(
          url.pathname.endsWith("/user")
            ? { id: 8, login: "viewer" }
            : url.pathname.endsWith("/pulls/1")
              ? { ...pr, user: { id: 7, login: "author" }, is_locked: true }
              : { archived: false, permissions: { push: false, pull: true, admin: false } },
        ),
      ),
    ),
  ),
);

it.effect(
  "disables archived comments while preserving reviews and labels supported by the API",
  () =>
    Effect.gen(function* () {
      const permissions = yield* make;
      const result = yield* permissions.getViewerPermissions(input, {
        ...pr,
        state: "open",
        user: null,
      });
      assert.isFalse(result.comment);
      assert.deepStrictEqual(result.verdicts, ["comment", "approve", "request-changes"]);
      assert.isTrue(result.labels);
    }).pipe(
      Effect.provide(
        harness((url) =>
          Response.json(
            url.pathname.endsWith("/user") ? { id: 8, login: "viewer" } : { archived: true },
          ),
        ),
      ),
    ),
);

it.effect("reloads viewer and archive state on each permission request", () => {
  let viewer = { id: 7, login: "author" };
  let archived = false;
  return Effect.gen(function* () {
    const permissions = yield* make;
    yield* permissions.getViewerPermissions(input);
    viewer = { id: 8, login: "other" };
    archived = true;
    const result = yield* permissions.getViewerPermissions(input);
    assert.isFalse(result.comment);
    assert.deepStrictEqual(result.verdicts, ["comment", "approve", "request-changes"]);
  }).pipe(
    Effect.provide(
      harness((url) =>
        Response.json(
          url.pathname.endsWith("/user")
            ? viewer
            : url.pathname.endsWith("/pulls/1")
              ? { ...pr, user: { id: 7, login: "author" } }
              : { archived },
        ),
      ),
    ),
  );
});

it.effect("propagates permission-read failures instead of granting stale rights", () =>
  Effect.gen(function* () {
    const permissions = yield* make;
    const error = yield* permissions
      .getViewerPermissions(input, { ...pr, state: "open", user: null })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "forbidden");
  }).pipe(Effect.provide(harness(() => new Response(null, { status: 403 })))),
);
