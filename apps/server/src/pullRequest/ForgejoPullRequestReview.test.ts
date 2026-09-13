import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { harness } from "../sourceControl/ForgejoApi.testSupport.ts";
import { threadIdentity } from "./forgejoActivityJson.ts";
import * as Review from "./ForgejoPullRequestReview.ts";

const decodeBody = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const input = { cwd: "/workspace", host: "forge.example", repository: "team/repo", number: 1 };
const snapshot = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };
const comment = {
  id: 9,
  body: "old",
  user: { id: 1, login: "operator" },
  created_at: "2026-09-01T00:00:00Z",
  html_url: "https://forge.example/team/repo/pulls/1#discussion_r9",
  pull_request_review_id: 7,
  path: "file.ts",
  position: 0,
  original_position: 12,
  commit_id: "old-commit",
  resolver: null,
};
const threadId = threadIdentity({ ...input, host: "https://forge.example/api/v1" }, comment);

it.effect("patches only the supplied pull request fields", () => {
  const { layer, execute } = harness(() => Response.json({}));
  return Effect.gen(function* () {
    const api = yield* Review.make;
    yield* api.updateChangeRequest({ ...input, body: "updated description" });
    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(request?.method, "PATCH");
    assert.isTrue(request?.url.endsWith("/pulls/1"));
    if (request?.body._tag === "Uint8Array")
      assert.deepStrictEqual(yield* decodeBody(new TextDecoder().decode(request.body.body)), {
        body: "updated description",
      });
  }).pipe(Effect.provide(layer));
});

for (const verdict of ["comment", "approve", "request-changes"] as const) {
  it.effect(`submits ${verdict} with both diff sides in one request`, () => {
    const { layer, execute } = harness((request) =>
      Response.json(
        request.url.endsWith("/user")
          ? { id: 1, login: "operator" }
          : request.url.endsWith("/pulls/1")
            ? { head: { sha: snapshot.headSha }, merge_base: snapshot.baseSha }
            : request.method === "GET"
              ? []
              : { id: 8 },
      ),
    );
    return Effect.gen(function* () {
      const api = yield* Review.make;
      yield* api.submitReview({
        ...input,
        verdict,
        body: "review",
        comments: [
          { snapshot, path: "file.ts", body: "old", position: { kind: "deleted", oldLine: 12 } },
          { snapshot, path: "file.ts", body: "new", position: { kind: "added", newLine: 14 } },
        ],
      });
      const writes = execute.mock.calls.map(([r]) => r).filter((r) => r.method === "POST");
      assert.strictEqual(writes.length, 1);
      const body = writes[0]?.body;
      assert.strictEqual(body?._tag, "Uint8Array");
      if (body?._tag === "Uint8Array")
        assert.deepStrictEqual(yield* decodeBody(new TextDecoder().decode(body.body)), {
          event: {
            comment: "COMMENT",
            approve: "APPROVED",
            "request-changes": "REQUEST_CHANGES",
          }[verdict],
          body: "review",
          commit_id: snapshot.headSha,
          comments: [
            { path: "file.ts", body: "old", old_position: 12, new_position: 0 },
            { path: "file.ts", body: "new", old_position: 0, new_position: 14 },
          ],
        });
    }).pipe(Effect.provide(layer));
  });
}

it.effect("blocks resubmission after a partial review left pending comments", () => {
  let pending = false;
  const { layer, execute } = harness((request) => {
    if (request.url.endsWith("/user")) return Response.json({ id: 1, login: "operator" });
    if (request.method === "GET")
      return Response.json(pending ? [{ id: 8, state: "PENDING", user: { id: 1 } }] : []);
    pending = true;
    return Response.json({}, { status: 500 });
  });
  return Effect.gen(function* () {
    const api = yield* Review.make;
    const draft = { ...input, verdict: "comment" as const, body: "review", comments: [] };
    const first = yield* api.submitReview(draft).pipe(Effect.flip);
    assert.include(first.detail, "Inspect");
    yield* api.submitReview(draft).pipe(Effect.flip);
    assert.strictEqual(execute.mock.calls.filter(([r]) => r.method === "POST").length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("replies using the original review and signed old-side position", () => {
  const { layer, execute } = harness((request) =>
    Response.json(request.method === "GET" ? [comment] : { id: 10 }),
  );
  return Effect.gen(function* () {
    const api = yield* Review.make;
    yield* api.replyToThread({ ...input, threadId, body: "reply" });
    const write = execute.mock.calls.find(([r]) => r.method === "POST")?.[0];
    assert.isTrue(write?.url.endsWith("/pulls/1/reviews/7/comments"));
    if (write?.body._tag === "Uint8Array")
      assert.deepStrictEqual(yield* decodeBody(new TextDecoder().decode(write.body.body)), {
        path: "file.ts",
        body: "reply",
        old_position: 12,
        new_position: 0,
      });
  }).pipe(Effect.provide(layer));
});

it.effect("rejects foreign and stale thread identities without posting", () => {
  const { layer, execute } = harness(() =>
    Response.json([{ ...comment, commit_id: "other-commit" }]),
  );
  return Effect.gen(function* () {
    const api = yield* Review.make;
    yield* api.replyToThread({ ...input, number: 2, threadId, body: "reply" }).pipe(Effect.flip);
    assert.strictEqual(execute.mock.calls.length, 0);
    yield* api.replyToThread({ ...input, threadId, body: "reply" }).pipe(Effect.flip);
    assert.strictEqual(execute.mock.calls.filter(([r]) => r.method === "POST").length, 0);
  }).pipe(Effect.provide(layer));
});

for (const own of [true, false]) {
  it.effect(`honors host edit permission (allowed=${own})`, () => {
    const { layer, execute } = harness((request) =>
      request.method === "PATCH" && !own
        ? Response.json({}, { status: 403 })
        : Response.json(
            request.url.endsWith("/user")
              ? { id: 1, login: "operator" }
              : request.url.endsWith("/pulls/1")
                ? { html_url: "https://forge.example/team/repo/pulls/1" }
                : {
                    id: 9,
                    user: { id: own ? 1 : 2 },
                    pull_request_url: "https://forge.example/team/repo/pulls/1",
                  },
          ),
    );
    return Effect.gen(function* () {
      const api = yield* Review.make;
      const edit = api.updateComment({
        ...input,
        commentId: "9",
        kind: "issue-comment",
        body: "edited",
      });
      if (own) yield* edit;
      else assert.strictEqual((yield* edit.pipe(Effect.flip)).reason, "forbidden");
      assert.strictEqual(execute.mock.calls.filter(([r]) => r.method === "PATCH").length, 1);
    }).pipe(Effect.provide(layer));
  });
}

it.effect(
  "refuses edits bound to another PR and edits inline remarks through the shared comment API",
  () => {
    let inline = false;
    const { layer, execute } = harness((request) => {
      if (request.url.endsWith("/pulls/1"))
        return Response.json({ html_url: "https://forge.example/team/repo/pulls/1" });
      if (request.url.includes("/reviews?"))
        return Response.json([{ id: 7, state: "COMMENT", user: { id: 1 } }]);
      if (request.url.endsWith("/reviews/7/comments")) return Response.json([comment]);
      return Response.json({
        id: 9,
        user: { id: 1 },
        pull_request_url: inline
          ? "https://forge.example/team/repo/pulls/1"
          : "https://forge.example/team/repo/pulls/2",
      });
    });
    return Effect.gen(function* () {
      const api = yield* Review.make;
      yield* api
        .updateComment({ ...input, commentId: "9", kind: "issue-comment", body: "edit" })
        .pipe(Effect.flip);
      assert.strictEqual(execute.mock.calls.filter(([r]) => r.method === "PATCH").length, 0);
      inline = true;
      yield* api.updateComment({ ...input, commentId: "9", kind: "review-comment", body: "edit" });
      assert.isTrue(
        execute.mock.calls
          .find(([r]) => r.method === "PATCH")?.[0]
          .url.endsWith("/issues/comments/9"),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("posts general discussion comments to the PR issue", () => {
  const { layer, execute } = harness(() => Response.json({ id: 12 }));
  return Effect.gen(function* () {
    const api = yield* Review.make;
    yield* api.comment({ ...input, body: "hello" });
    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(request?.method, "POST");
    assert.isTrue(request?.url.endsWith("/issues/1/comments"));
    if (request?.body._tag === "Uint8Array")
      assert.deepStrictEqual(yield* decodeBody(new TextDecoder().decode(request.body.body)), {
        body: "hello",
      });
  }).pipe(Effect.provide(layer));
});

for (const scenario of ["missing", "mixed", "stale-head", "stale-base", "invalid-sha"] as const) {
  it.effect(`refuses inline review with ${scenario} snapshot before publication`, () => {
    const { layer, execute } = harness((request) =>
      Response.json(
        request.url.endsWith("/user")
          ? { id: 1, login: "operator" }
          : request.url.endsWith("/pulls/1")
            ? {
                head: { sha: scenario === "stale-head" ? "c".repeat(40) : snapshot.headSha },
                merge_base: scenario === "stale-base" ? "d".repeat(40) : snapshot.baseSha,
              }
            : [],
      ),
    );
    return Effect.gen(function* () {
      const api = yield* Review.make;
      const draft = {
        path: "file.ts",
        body: "line",
        position: { kind: "added" as const, newLine: 1 },
      };
      const comments =
        scenario === "missing"
          ? [draft]
          : [
              { ...draft, snapshot },
              {
                ...draft,
                snapshot:
                  scenario === "mixed"
                    ? { ...snapshot, headSha: "c".repeat(40) }
                    : scenario === "invalid-sha"
                      ? { ...snapshot, headSha: "branch-name" }
                      : snapshot,
              },
            ];
      yield* api
        .submitReview({ ...input, verdict: "comment", body: "review", comments })
        .pipe(Effect.flip);
      assert.strictEqual(execute.mock.calls.filter(([r]) => r.method === "POST").length, 0);
    }).pipe(Effect.provide(layer));
  });
}
