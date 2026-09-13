import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Api from "../sourceControl/ForgejoApi.ts";
import { make } from "./ForgejoPullRequestMetadata.ts";

const input = { cwd: "/repo", host: "forge.example", repository: "org/repo", number: 1 };
const harness = (respond: (url: URL, method: string, body: string) => Response) =>
  Api.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              respond(
                new URL(request.url),
                request.method,
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : "",
              ),
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
const user = { id: 2, login: "bob" };
const team = { id: 2, name: "bob", units: ["repo.pulls"], permission: "read" };
it.effect("lists users and teams in separate namespaces and excludes the author by ID", () => {
  const layer = harness((url) =>
    Response.json(
      url.pathname.endsWith("/pulls/1")
        ? {
            user: { id: 1, login: "ALICE" },
            requested_reviewers: [user],
            requested_reviewers_teams: [team],
          }
        : url.pathname.endsWith("/reviews")
          ? [
              { state: "REQUEST_REVIEW", user, team: null },
              { state: "REQUEST_REVIEW", user: null, team },
            ]
          : url.pathname.endsWith("/reviewers")
            ? [user, { id: 1, login: "alice" }]
            : [team],
    ),
  );
  return Effect.gen(function* () {
    const metadata = yield* make;
    const result = yield* metadata.listReviewerCandidates(input);
    assert.deepStrictEqual(
      result.candidates.map(({ id, kind, isRequested }) => ({ id, kind, isRequested })),
      [
        { id: "bob", kind: "user", isRequested: true },
        { id: "bob", kind: "team", isRequested: true },
      ],
    );
  }).pipe(Effect.provide(layer));
});
it.effect("clears historical reviewers while preserving paginated active requests", () => {
  const layer = harness((url) => {
    if (url.pathname.endsWith("/pulls/1"))
      return Response.json({
        user: null,
        requested_reviewers: [user],
        requested_reviewers_teams: [team],
      });
    if (url.pathname.endsWith("/reviews"))
      return url.searchParams.get("page") === "2"
        ? Response.json([{ state: "REQUEST_REVIEW", user: { id: 3, login: "carol" }, team: null }])
        : Response.json([{ state: "APPROVED", user, team: null }], {
            headers: {
              link: '<https://forge.example/api/v1/repos/org/repo/pulls/1/reviews?page=2>; rel="next"',
            },
          });
    return Response.json(
      url.pathname.endsWith("/reviewers") ? [user, { id: 3, login: "carol" }] : [team],
    );
  });
  return Effect.gen(function* () {
    const metadata = yield* make;
    const result = yield* metadata.listReviewerCandidates(input);
    assert.deepStrictEqual(
      result.candidates.map(({ id, kind, isRequested }) => ({ id, kind, isRequested })),
      [
        { id: "bob", kind: "user", isRequested: false },
        { id: "carol", kind: "user", isRequested: true },
        { id: "bob", kind: "team", isRequested: false },
      ],
    );
  }).pipe(Effect.provide(layer));
});
for (const requested of [true, false]) {
  it.effect(`uses distinct user and team fields when review requested=${requested}`, () => {
    const requests: unknown[] = [];
    const layer = harness((url, method, body) => {
      requests.push({ path: url.pathname, method, body: JSON.parse(body) });
      return requested ? Response.json([]) : new Response(null, { status: 204 });
    });
    return Effect.gen(function* () {
      const metadata = yield* make;
      yield* metadata.setReviewerRequest({
        ...input,
        requested,
        reviewers: [
          { kind: "user", id: "bob" },
          { kind: "team", id: "bob" },
        ],
      });
      assert.deepStrictEqual(requests, [
        {
          path: "/api/v1/repos/org/repo/pulls/1/requested_reviewers",
          method: requested ? "POST" : "DELETE",
          body: { reviewers: ["bob"], team_reviewers: ["bob"] },
        },
      ]);
    }).pipe(Effect.provide(layer));
  });
}
it.effect("adds labels without replacing labels added by another actor", () => {
  const layer = harness((_url, method, body) => {
    assert.strictEqual(method, "POST");
    assert.deepStrictEqual(JSON.parse(body), { labels: ["bug"] });
    return Response.json([]);
  });
  return Effect.gen(function* () {
    const metadata = yield* make;
    yield* metadata.setLabels({ ...input, labels: ["bug"], applied: true });
  }).pipe(Effect.provide(layer));
});
it.effect("removes only selected labels using their numeric identities", () => {
  const deletes: string[] = [];
  const layer = harness((url, method) => {
    if (method === "GET")
      return Response.json([{ id: 7, name: "123", color: "ff0000", description: "" }]);
    deletes.push(url.pathname);
    return new Response(null, { status: 204 });
  });
  return Effect.gen(function* () {
    const metadata = yield* make;
    yield* metadata.setLabels({ ...input, labels: ["123"], applied: false });
    assert.deepStrictEqual(deletes, ["/api/v1/repos/org/repo/issues/1/labels/7"]);
  }).pipe(Effect.provide(layer));
});
for (const [content, nativeContent] of [
  ["thumbs-up", "+1"],
  ["thumbs-down", "-1"],
  ["laugh", "laugh"],
  ["hooray", "hooray"],
  ["confused", "confused"],
  ["heart", "heart"],
  ["rocket", "rocket"],
  ["eyes", "eyes"],
] as const) {
  for (const reacted of [true, false]) {
    it.effect(`writes ${content} reacted=${reacted} on the comment endpoint`, () => {
      const layer = harness((url, method, body) => {
        assert.strictEqual(url.pathname, "/api/v1/repos/org/repo/issues/comments/42/reactions");
        assert.strictEqual(method, reacted ? "POST" : "DELETE");
        assert.deepStrictEqual(JSON.parse(body), { content: nativeContent });
        return reacted ? Response.json({}) : new Response("", { status: 200 });
      });
      return Effect.gen(function* () {
        const metadata = yield* make;
        yield* metadata.setReaction({ ...input, subjectId: "42", content, reacted });
      }).pipe(Effect.provide(layer));
    });
  }
}
it.effect("rejects a review identity instead of reacting to an unrelated comment", () =>
  Effect.gen(function* () {
    const metadata = yield* make;
    const error = yield* metadata
      .setReaction({ ...input, subjectId: "review:42", content: "heart", reacted: true })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "invalid-response");
  }).pipe(
    Effect.provide(
      harness(() => {
        assert.fail("must not issue an HTTP request");
      }),
    ),
  ),
);
it.effect("follows label pagination and marks applied labels by ID", () => {
  const layer = harness((url) =>
    url.pathname.startsWith("/api/v1/orgs/")
      ? Response.json([
          { id: 3, name: "org-label", color: "" },
          { id: 4, name: "bug", color: "" },
        ])
      : url.pathname.includes("/issues/")
        ? Response.json([{ id: 2, name: "renamed", color: "" }])
        : url.searchParams.get("page") === "2"
          ? Response.json([{ id: 2, name: "bug", color: "ff0000" }])
          : Response.json([{ id: 1, name: "first", color: "" }], {
              headers: {
                link: '<https://forge.example/api/v1/repos/org/repo/labels?page=2>; rel="next"',
              },
            }),
  );
  return Effect.gen(function* () {
    const metadata = yield* make;
    const result = yield* metadata.listLabelCandidates(input);
    assert.deepStrictEqual(
      result.candidates.map(({ name, isApplied }) => ({ name, isApplied })),
      [
        { name: "first", isApplied: false },
        { name: "bug", isApplied: true },
        { name: "org-label", isApplied: false },
      ],
    );
    assert.isFalse(result.truncated);
  }).pipe(Effect.provide(layer));
});
it.effect("rejects looping candidate pagination", () => {
  const layer = harness(() =>
    Response.json([], {
      headers: { link: '<https://forge.example/api/v1/repos/org/repo/labels?page=2>; rel="next"' },
    }),
  );
  return Effect.gen(function* () {
    const metadata = yield* make;
    const error = yield* metadata.listLabelCandidates(input).pipe(Effect.flip);
    assert.strictEqual(error.reason, "invalid-response");
  }).pipe(Effect.provide(layer));
});
it.effect("reacts to the pull request description through its issue endpoint", () => {
  const layer = harness((url) => {
    assert.strictEqual(url.pathname, "/api/v1/repos/org/repo/issues/1/reactions");
    return Response.json({});
  });
  return Effect.gen(function* () {
    const metadata = yield* make;
    yield* metadata.setReaction({ ...input, content: "heart", reacted: true });
  }).pipe(Effect.provide(layer));
});
for (const method of ["reviewer", "labels", "reaction"] as const) {
  it.effect(`preserves actor permission failures for ${method}`, () => {
    const layer = harness(() => new Response(null, { status: 403 }));
    return Effect.gen(function* () {
      const metadata = yield* make;
      const action =
        method === "reviewer"
          ? metadata.setReviewerRequest({
              ...input,
              requested: true,
              reviewers: [{ kind: "team", id: "dev" }],
            })
          : method === "labels"
            ? metadata.setLabels({ ...input, applied: true, labels: ["bug"] })
            : metadata.setReaction({ ...input, content: "heart", reacted: true });
      const error = yield* action.pipe(Effect.flip);
      assert.strictEqual(error.reason, "forbidden");
      assert.strictEqual(error.status, 403);
    }).pipe(Effect.provide(layer));
  });
}
it.effect("lists users for a personal repository with no teams", () => {
  const layer = harness((url) =>
    url.pathname.endsWith("/teams")
      ? new Response(null, { status: 405 })
      : Response.json(
          url.pathname.endsWith("/reviews")
            ? []
            : url.pathname.endsWith("/reviewers")
              ? [user]
              : { user: null, requested_reviewers: [], requested_reviewers_teams: [] },
        ),
  );
  return Effect.gen(function* () {
    const metadata = yield* make;
    const result = yield* metadata.listReviewerCandidates(input);
    assert.strictEqual(result.candidates.length, 1);
  }).pipe(Effect.provide(layer));
});
