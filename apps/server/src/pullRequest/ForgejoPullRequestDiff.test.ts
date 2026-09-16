import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { harness as apiHarness } from "../sourceControl/ForgejoApi.testSupport.ts";
import { make } from "./ForgejoPullRequestDiff.ts";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const oldHeadSha = "c".repeat(40);
const input = { cwd: "/unused", repository: "team/repo", host: "forge.example", number: 7 };
const snapshot = { baseSha, headSha };
const file = {
  ...input,
  snapshot,
  changeType: "change" as const,
  oldPath: "old.ts",
  newPath: "new.ts",
};
const patch =
  "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n";

function harness(respond: (url: string) => Response) {
  const calls: string[] = [];
  const { layer } = apiHarness((request) => {
    calls.push(request.url);
    return respond(request.url);
  });
  return { layer, calls };
}

function response(url: string, diff = patch) {
  if (url.endsWith("/pulls/7")) return Response.json({ merge_base: baseSha });
  if (url.endsWith("/git/refs/pull/7/head"))
    return Response.json([{ ref: "refs/pull/7/head", object: { sha: headSha } }]);
  if (url.endsWith(".diff")) return new Response(diff);
  return new Response("missing", { status: 404 });
}

it.effect("preserves rename and binary patches with exact pull-ref snapshots", () => {
  const binary =
    "diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n";
  const { layer } = harness((url) => response(url, patch + binary));
  return Effect.gen(function* () {
    const diff = yield* make;
    assert.deepStrictEqual(yield* diff.getDiff(input), {
      patch: patch + binary,
      truncated: true,
      nextCursor: null,
      snapshot,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("marks a patch larger than the transport limit as truncated", () => {
  const { layer } = harness((url) => response(url, patch + "x".repeat(8 * 1024 * 1024)));
  return Effect.gen(function* () {
    const diff = yield* make;
    const result = yield* diff.getDiff(input);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.patch.length, 8 * 1024 * 1024);
    assert.strictEqual(result.nextCursor, null);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps a pure rename complete when there are no omitted binary hunks", () => {
  const { layer } = harness(response);
  return Effect.gen(function* () {
    const diff = yield* make;
    const result = yield* diff.getDiff(input);
    assert.strictEqual(result.patch, patch);
    assert.strictEqual(result.truncated, false);
  }).pipe(Effect.provide(layer));
});

it.effect("rejects a PR moving while its patch is being read", () => {
  let reads = 0;
  const { layer } = harness((url) =>
    url.endsWith("/git/refs/pull/7/head")
      ? Response.json([
          { ref: "refs/pull/7/head", object: { sha: reads++ === 0 ? oldHeadSha : headSha } },
        ])
      : response(url),
  );
  return Effect.gen(function* () {
    const diff = yield* make;
    assert.strictEqual((yield* diff.getDiff(input).pipe(Effect.flip)).reason, "invalid-response");
  }).pipe(Effect.provide(layer));
});

it.effect("does not substitute another ref when the exact pull ref is absent", () => {
  const { layer } = harness((url) =>
    url.endsWith("/git/refs/pull/7/head")
      ? Response.json([{ ref: "refs/pull/7/head-other", object: { sha: headSha } }])
      : response(url),
  );
  return Effect.gen(function* () {
    const diff = yield* make;
    assert.strictEqual((yield* diff.getDiff(input).pipe(Effect.flip)).reason, "invalid-response");
  }).pipe(Effect.provide(layer));
});

it.effect("expands renamed paths at the supplied SHAs even after the branch advances", () => {
  const { layer, calls } = harness(
    (url) => new Response(url.includes(`ref=${baseSha}`) ? "old" : "new"),
  );
  return Effect.gen(function* () {
    const diff = yield* make;
    const result = yield* diff.getDiffFileContents({
      ...file,
      changeType: "rename-changed",
      oldPath: "dir/a %2F.ts",
      newPath: "dir/b #?.ts",
    });
    assert.deepStrictEqual(result, { oldContents: "old", newContents: "new" });
    assert.deepStrictEqual(calls, [
      `https://forge.example/api/v1/repos/team/repo/raw/dir/a%20%252F.ts?ref=${baseSha}`,
      `https://forge.example/api/v1/repos/team/repo/raw/dir/b%20%23%3F.ts?ref=${headSha}`,
    ]);
  }).pipe(Effect.provide(layer));
});

for (const changeType of ["new", "deleted"] as const) {
  it.effect(`reads only the existing side for a ${changeType} file`, () => {
    const { layer, calls } = harness(() => new Response("content"));
    return Effect.gen(function* () {
      const diff = yield* make;
      const result = yield* diff.getDiffFileContents({ ...file, changeType });
      assert.deepStrictEqual(
        result,
        changeType === "new"
          ? { oldContents: "", newContents: "content" }
          : { oldContents: "content", newContents: "" },
      );
      assert.strictEqual(calls.length, 1);
    }).pipe(Effect.provide(layer));
  });
}

for (const content of ["binary\0", "x".repeat(8 * 1024 * 1024 + 1), new Uint8Array([255])]) {
  it.effect(
    `rejects unavailable text expansion (${typeof content === "string" ? content.length : "invalid UTF-8"})`,
    () => {
      const { layer } = harness(() => new Response(content));
      return Effect.gen(function* () {
        const diff = yield* make;
        assert.strictEqual(
          (yield* diff.getDiffFileContents(file).pipe(Effect.flip)).reason,
          "invalid-response",
        );
      }).pipe(Effect.provide(layer));
    },
  );
}

it.effect("retains a missing file error instead of inventing empty contents", () => {
  const { layer } = harness(() => new Response(null, { status: 404 }));
  return Effect.gen(function* () {
    const diff = yield* make;
    assert.strictEqual(
      (yield* diff.getDiffFileContents(file).pipe(Effect.flip)).reason,
      "not-found",
    );
  }).pipe(Effect.provide(layer));
});

for (const parents of [[], [{ sha: baseSha }, { sha: oldHeadSha }]]) {
  it.effect(
    `uses ${parents.length ? "first parent" : "null old side"} for a commit snapshot`,
    () => {
      const { layer, calls } = harness((url) =>
        url.endsWith(".diff") ? new Response(patch) : Response.json({ sha: headSha, parents }),
      );
      return Effect.gen(function* () {
        const diff = yield* make;
        const result = yield* diff.getDiff({ ...input, commit: headSha });
        assert.deepStrictEqual(result.snapshot, { baseSha: parents[0]?.sha ?? null, headSha });
        assert.ok(calls.every((url) => url.includes(`/git/commits/${headSha}`)));
      }).pipe(Effect.provide(layer));
    },
  );
}

it.effect("refuses expansion without a snapshot and sends no current-branch requests", () => {
  const { layer, calls } = harness(response);
  return Effect.gen(function* () {
    const diff = yield* make;
    const { snapshot: _snapshot, ...withoutSnapshot } = file;
    assert.strictEqual(
      (yield* diff.getDiffFileContents(withoutSnapshot).pipe(Effect.flip)).reason,
      "invalid-response",
    );
    assert.deepStrictEqual(calls, []);
  }).pipe(Effect.provide(layer));
});

it.effect("expands a root commit's new file without requesting a parent", () => {
  const { layer, calls } = harness(() => new Response("initial"));
  return Effect.gen(function* () {
    const diff = yield* make;
    const result = yield* diff.getDiffFileContents({
      ...file,
      commit: headSha,
      changeType: "new",
      snapshot: { baseSha: null, headSha },
    });
    assert.deepStrictEqual(result, { oldContents: "", newContents: "initial" });
    assert.deepStrictEqual(calls, [
      `https://forge.example/api/v1/repos/team/repo/raw/new.ts?ref=${headSha}`,
    ]);
  }).pipe(Effect.provide(layer));
});

for (const selector of [{ commit: "main" }, { cursor: "next" }]) {
  it.effect(
    `rejects unsupported diff selectors before requesting the API (${Object.keys(selector)[0]})`,
    () => {
      const { layer, calls } = harness(response);
      return Effect.gen(function* () {
        const diff = yield* make;
        assert.strictEqual(
          (yield* diff.getDiff({ ...input, ...selector }).pipe(Effect.flip)).reason,
          "invalid-response",
        );
        assert.deepStrictEqual(calls, []);
      }).pipe(Effect.provide(layer));
    },
  );
}

it.effect("rejects a file snapshot for another commit", () => {
  const { layer, calls } = harness(response);
  return Effect.gen(function* () {
    const diff = yield* make;
    assert.strictEqual(
      (yield* diff.getDiffFileContents({ ...file, commit: oldHeadSha }).pipe(Effect.flip)).reason,
      "invalid-response",
    );
    assert.deepStrictEqual(calls, []);
  }).pipe(Effect.provide(layer));
});
