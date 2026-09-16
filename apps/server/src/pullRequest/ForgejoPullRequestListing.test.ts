import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { make } from "./ForgejoPullRequestListing.ts";
import { harness, pullRequestFixture as pr } from "./forgejoPullRequestTestHarness.ts";

const input = {
  cwd: "/repo",
  host: "forge.example",
  repository: "team/repo",
  state: "all" as const,
  involvement: "all" as const,
  viewer: "bob",
  limit: 1,
};
it.effect("continues through null rows and equal timestamps without losing filtered PRs", () => {
  const layer = harness((url) =>
    url.searchParams.get("page") === "2"
      ? Response.json([
          { ...pr, number: 2 },
          { ...pr, number: 3 },
        ])
      : Response.json([null, { ...pr, number: 9, state: "closed", merged: true }, pr], {
          headers: {
            link: '<https://forge.example/api/v1/repos/team/repo/pulls?page=2>; rel="next"',
          },
        }),
  );
  return Effect.gen(function* () {
    const list = yield* make;
    const first = yield* list({ ...input, state: "open" });
    const second = yield* list({
      ...input,
      state: "open",
      cursor: { delivered: first.cursorAdvance, updatedBefore: pr.updated_at },
    });
    assert.deepStrictEqual(
      first.items.map((row) => row.number),
      [1],
    );
    assert.deepStrictEqual(
      second.items.map((row) => row.number),
      [2],
    );
    assert.isTrue(first.truncated);
  }).pipe(Effect.provide(layer));
});
it.effect("hydrates issue search results into actual PR heads and line counts", () => {
  const paths: string[] = [];
  const layer = harness((url) => {
    paths.push(url.pathname);
    return Response.json(url.pathname.endsWith("issues") ? [{ number: 1 }] : pr);
  });
  return Effect.gen(function* () {
    const list = yield* make;
    const result = yield* list({ ...input, query: "description" });
    assert.strictEqual(result.items[0]?.headBranch, "feature");
    assert.strictEqual(result.items[0]?.additions, 8);
    assert.deepStrictEqual(paths, [
      "/api/v1/repos/team/repo/issues",
      "/api/v1/repos/team/repo/pulls/1",
    ]);
  }).pipe(Effect.provide(layer));
});
for (const involvement of ["authored", "reviewing"] as const) {
  it.effect(`filters ${involvement} using the selected viewer account`, () => {
    const layer = harness(() =>
      Response.json([
        pr,
        { ...pr, number: 2, user: { id: 4, login: "bob" }, requested_reviewers: [] },
      ]),
    );
    return Effect.gen(function* () {
      const list = yield* make;
      const result = yield* list({ ...input, involvement });
      assert.deepStrictEqual(
        result.items.map((row) => row.number),
        involvement === "authored" ? [2] : [1],
      );
    }).pipe(Effect.provide(layer));
  });
}
it.effect("separates merged PRs from closed PRs", () => {
  const layer = harness(() =>
    Response.json([
      { ...pr, state: "closed", merged: true },
      { ...pr, number: 2, state: "closed" },
    ]),
  );
  return Effect.gen(function* () {
    const list = yield* make;
    const result = yield* list({ ...input, state: "closed" });
    assert.deepStrictEqual(
      result.items.map((row) => row.number),
      [2],
    );
  }).pipe(Effect.provide(layer));
});
it.effect("filters draft, author and labels before choosing the requested slice", () => {
  const layer = harness(() =>
    Response.json([
      pr,
      { ...pr, number: 2, draft: true },
      { ...pr, number: 3, draft: true, labels: [{ name: "blocked", color: "" }] },
    ]),
  );
  return Effect.gen(function* () {
    const list = yield* make;
    const result = yield* list({
      ...input,
      filters: { draft: "only", author: "alice", labels: [["BUG"]], excludedLabels: ["blocked"] },
    });
    assert.deepStrictEqual(
      result.items.map((row) => row.number),
      [2],
    );
  }).pipe(Effect.provide(layer));
});
it.effect("rejects a looping pagination link instead of repeating the read", () => {
  let calls = 0;
  const layer = harness(() =>
    ++calls > 3
      ? new Response(null, { status: 500 })
      : Response.json([], {
          headers: {
            link: '<https://forge.example/api/v1/repos/team/repo/pulls?page=2>; rel="next"',
          },
        }),
  );
  return Effect.gen(function* () {
    const list = yield* make;
    const error = yield* list(input).pipe(Effect.flip);
    assert.strictEqual(error.reason, "invalid-response");
    assert.strictEqual(calls, 2);
  }).pipe(Effect.provide(layer));
});
it.effect(
  "does not claim approval when the protected branch requires two official approvals",
  () => {
    const layer = harness((url) =>
      url.pathname.endsWith("/reviews")
        ? Response.json([
            {
              id: 1,
              state: "APPROVED",
              official: true,
              stale: false,
              dismissed: false,
              user: { login: "bob" },
            },
          ])
        : url.pathname.includes("/branches/")
          ? Response.json({ required_approvals: 2 })
          : Response.json([pr]),
    );
    return Effect.gen(function* () {
      const list = yield* make;
      const result = yield* list({ ...input, filters: { review: "approved" } });
      assert.deepStrictEqual(result.items, []);
    }).pipe(Effect.provide(layer));
  },
);
