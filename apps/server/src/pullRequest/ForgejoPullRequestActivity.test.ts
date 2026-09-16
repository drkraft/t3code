import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Api from "../sourceControl/ForgejoApi.ts";
import { make } from "./ForgejoPullRequestActivity.ts";

const author = { id: 1, login: "viewer" };
const created = "2026-09-12T12:00:00Z";
const comment = {
  id: 11,
  body: "hello",
  user: author,
  html_url: "https://forge.example/a/b/pulls/3#issuecomment-11",
  created_at: created,
};
const review = {
  id: 4,
  body: "looks good",
  user: author,
  submitted_at: created,
  html_url: "https://forge.example/a/b/pulls/3#issuecomment-12",
  state: "APPROVED",
  dismissed: false,
  comments_count: 2,
};
const codeComment = {
  ...comment,
  id: 13,
  pull_request_review_id: 4,
  path: "file.ts",
  position: 0,
  original_position: 7,
  commit_id: "abc",
  resolver: author,
};
const input = { cwd: "/repo", host: "forge.example", repository: "a/b", number: 3 };
function layer(respond: (url: URL) => Response) {
  return Api.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, respond(new URL(request.url)))),
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
}
function respond(url: URL): Response {
  const path = url.pathname;
  if (path.endsWith("/user")) return Response.json(author);
  if (path.endsWith("/issues/3/comments")) return Response.json([comment]);
  if (path.endsWith("/reviews"))
    return Response.json([
      review,
      { ...review, id: 5, state: "PENDING", user: { id: 2, login: "other" } },
    ]);
  if (path.endsWith("/reviews/4/comments"))
    return Response.json([codeComment, { ...codeComment, id: 14, body: "reply" }]);
  if (path.endsWith("/commits"))
    return Response.json([
      {
        sha: "abc",
        author,
        commit: { message: "real commit\nbody", committer: { date: created } },
      },
    ]);
  if (path.endsWith("/reactions")) return Response.json([{ content: "heart", user: author }]);
  return new Response(null, { status: 500 });
}

it.effect(
  "reads review verdicts and line replies without duplicating their conversation rows",
  () =>
    Effect.gen(function* () {
      const service = yield* make;
      const activity = yield* service.getChangeRequestActivity(input);
      assert.deepEqual(activity.comments.map((row) => row.id).sort(), ["11", "12", "13", "14"]);
      assert.equal(activity.commentCount, 4);
      assert.equal(activity.reviewThreads.length, 1);
      assert.equal(activity.reviewThreads[0]?.isResolved, true);
      assert.equal(activity.reviewThreads[0]?.isOutdated, null);
      assert.equal(activity.reviewThreads[0]?.comments[0]?.reactions?.[0]?.content, "heart");
      assert.equal(activity.reviewThreads[0]?.side, "left");
      assert.equal(activity.reviewThreads[0]?.line, 7);
      assert.equal(activity.reviewThreads[0]?.comments.length, 2);
      assert.equal(activity.commits[0]?.oid, "abc");
      assert.equal(activity.comments.find((row) => row.id === "12")?.reviewState, "APPROVED");
      assert.equal(activity.commentsTruncated, false);
    }).pipe(Effect.provide(layer(respond))),
);

it.effect(
  "continues short visible review pages when pending reviews were filtered by Forgejo",
  () =>
    Effect.gen(function* () {
      const service = yield* make;
      const activity = yield* service.getChangeRequestActivity(input);
      assert.include(
        activity.comments.map((row) => row.id),
        "12",
      );
    }).pipe(
      Effect.provide(
        layer((url) =>
          url.pathname.endsWith("/reviews") && !url.searchParams.has("page")
            ? Response.json([], {
                headers: {
                  link: '<https://forge.example/api/v1/repos/a/b/pulls/3/reviews?page=2>; rel="next"',
                },
              })
            : respond(url),
        ),
      ),
    ),
);

it.effect("deduplicates issue comments across pages and preserves empty reactions", () =>
  Effect.gen(function* () {
    const service = yield* make;
    const activity = yield* service.getChangeRequestActivity(input);
    assert.equal(activity.comments.filter((row) => row.id === "11").length, 1);
    assert.deepEqual(activity.reactions, []);
  }).pipe(
    Effect.provide(
      layer((url) => {
        if (url.pathname.endsWith("/reactions")) return Response.json(null);
        if (url.pathname.endsWith("/issues/3/comments") && !url.searchParams.has("page"))
          return Response.json([comment], {
            headers: {
              link: '<https://forge.example/api/v1/repos/a/b/issues/3/comments?page=2>; rel="next"',
            },
          });
        return respond(url);
      }),
    ),
  ),
);

it.effect(
  "reports an incomplete conversation when the server count exceeds delivered code replies",
  () =>
    Effect.gen(function* () {
      const service = yield* make;
      const activity = yield* service.getChangeRequestActivity(input);
      assert.equal(activity.commentCount, 4);
      assert.equal(activity.commentsTruncated, true);
    }).pipe(
      Effect.provide(
        layer((url) =>
          url.pathname.endsWith("/reviews/4/comments")
            ? Response.json([codeComment])
            : respond(url),
        ),
      ),
    ),
);

it.effect("fails a deleted pull request rather than reporting empty activity", () =>
  Effect.gen(function* () {
    const service = yield* make;
    const result = yield* service.getChangeRequestActivity(input).pipe(Effect.flip);
    assert.equal(result.reason, "not-found");
  }).pipe(
    Effect.provide(
      layer((url) =>
        url.pathname.endsWith("/commits") ? new Response(null, { status: 404 }) : respond(url),
      ),
    ),
  ),
);
