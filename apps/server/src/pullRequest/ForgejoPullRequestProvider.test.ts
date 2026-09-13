import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, DateTime } from "effect";
import * as Vcs from "../vcs/VcsDriver.ts";
import * as VcsRegistry from "../vcs/VcsDriverRegistry.ts";
import * as Provider from "./ForgejoPullRequestProvider.ts";
import { harness, apiHarness } from "../sourceControl/forgejoSourceControlTestUtils.ts";
import { pullRequestFixture as pr } from "./forgejoPullRequestTestHarness.ts";

const input = { cwd: "/repo", host: "forge.example", repository: "team/repo", number: 1 };
it.effect(
  "reads detail with current-head checks and advertises review writes and U6 actions",
  () => {
    const { layer, requests } = harness((request) =>
      request.url.includes("/branches/")
        ? Response.json({
            protected: false,
            user_can_merge: false,
            user_can_push: false,
            enable_status_check: false,
            status_check_contexts: [],
            required_approvals: 0,
          })
        : request.url.endsWith("/user")
          ? Response.json({ id: 7, login: "reviewer" })
          : request.url.endsWith("/repos/team/repo") || request.url.endsWith("/repos/alice/repo")
            ? Response.json({
                archived: false,
                has_pull_requests: true,
                permissions: { pull: true, push: true, admin: false },
              })
            : request.url.includes("/reviews?")
              ? Response.json([
                  { state: "REQUEST_REVIEW", user: { id: 3, login: "carol" }, team: null },
                ])
              : request.url.includes("/statuses/")
                ? Response.json([])
                : request.url.includes("/actions/runs")
                  ? Response.json({ total_count: 0, workflow_runs: [] })
                  : Response.json({
                      ...pr,
                      is_locked: false,
                      requested_reviewers_teams: [{ id: 9, name: "maintainers" }],
                    }),
    );
    return Effect.gen(function* () {
      const provider = yield* Provider.make;
      const detail = yield* provider.getChangeRequest(input);
      assert.strictEqual(detail.body, "Description");
      assert.strictEqual(detail.changedFiles, 1);
      assert.deepStrictEqual(
        detail.reviewers.map((reviewer) => reviewer.login),
        ["carol"],
      );
      assert.isTrue(requests.some((request) => request.url.includes("/statuses/new-head")));
      assert.deepStrictEqual(detail.viewerPermissions.actions, ["close"]);
      assert.deepStrictEqual(provider.capabilities.actions, [
        "merge",
        "close",
        "reopen",
        "draft",
        "ready",
        "update-branch",
      ]);
      assert.isTrue(provider.capabilities.comment);
      assert.isTrue(provider.capabilities.review.inlineComment);
      assert.isTrue(provider.capabilities.review.reply);
      assert.isFalse(provider.capabilities.review.resolve);
      assert.deepStrictEqual(provider.capabilities.review.verdicts, [
        "comment",
        "approve",
        "request-changes",
      ]);
      assert.isTrue(requests.every((request) => request.method === "GET"));
    }).pipe(Effect.provide(layer));
  },
);
it.effect("preserves removed-PR errors without inventing an empty detail", () => {
  const { layer } = harness(() => new Response(null, { status: 404 }));
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    const error = yield* provider.getChangeRequest(input).pipe(Effect.flip);
    assert.strictEqual(error.reason, "failed");
    assert.strictEqual(error.operation, "getChangeRequest");
  }).pipe(Effect.provide(layer));
});
it.effect(
  "refreshes closed and reopened summary state without requesting activity or checks",
  () => {
    let state = "closed";
    const { layer, requests } = harness(() => Response.json({ ...pr, state }));
    return Effect.gen(function* () {
      const provider = yield* Provider.make;
      assert.isDefined(provider.getChangeRequestSummary);
      if (!provider.getChangeRequestSummary) return;
      const closed = yield* provider.getChangeRequestSummary(input);
      state = "open";
      const reopened = yield* provider.getChangeRequestSummary(input);
      assert.deepStrictEqual([closed.state, reopened.state], ["closed", "open"]);
      assert.strictEqual(requests.length, 2);
    }).pipe(Effect.provide(layer));
  },
);
it.effect(
  "selects viewer credentials from each cwd when two instances share repository names",
  () => {
    const { layer, requests } = apiHarness(
      (request) =>
        Response.json({
          id: 1,
          login: request.url.includes("other.example") ? "second-account" : "first-account",
        }),
      true,
    );
    const freshness = {
      source: "live-local" as const,
      observedAt: DateTime.makeUnsafe("2026-09-12T00:00:00.000Z"),
      expiresAt: Option.none<DateTime.Utc>(),
    };
    const vcs = Layer.mock(Vcs.VcsDriver)({
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
          freshness,
          remotes: [
            {
              name: "origin",
              url: `https://${cwd === "/second" ? "other.example" : "forge.example"}/team/repo.git`,
              pushUrl: Option.none(),
              isPrimary: true,
            },
          ],
        }),
    });
    const registry = Layer.effect(
      VcsRegistry.VcsDriverRegistry,
      Effect.gen(function* () {
        const driver = yield* Vcs.VcsDriver;
        const detect: VcsRegistry.VcsDriverRegistry["Service"]["detect"] = ({ cwd }) =>
          Effect.succeed({
            kind: "git",
            driver,
            repository: { kind: "git", rootPath: cwd, metadataPath: null, freshness },
          });
        return VcsRegistry.VcsDriverRegistry.of({
          detect,
          get: () => Effect.succeed(driver),
          resolve: ({ cwd }) =>
            Effect.succeed({
              kind: "git",
              driver,
              repository: { kind: "git", rootPath: cwd, metadataPath: null, freshness },
            }),
        });
      }),
    ).pipe(Layer.provide(vcs));
    return Effect.gen(function* () {
      const provider = yield* Provider.make;
      const accounts = yield* Effect.all([
        provider.getViewer({ cwd: "/first" }),
        provider.getViewer({ cwd: "/second" }),
      ]);
      assert.deepStrictEqual(accounts, ["first-account", "second-account"]);
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        ["https://forge.example/api/v1/user", "https://other.example/api/v1/user"],
      );
    }).pipe(Effect.provide(Layer.merge(registry, layer)));
  },
);
it.effect("preserves exact diff snapshots through the provider and file expansion", () => {
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const snapshot = { baseSha, headSha };
  const patch = "diff --git a/a.ts b/a.ts\n";
  const { layer, requests } = harness((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith(".diff")) return new Response(patch);
    if (url.pathname.includes("/raw/"))
      return new Response(url.searchParams.get("ref") === baseSha ? "old" : "new");
    if (url.pathname.includes("/git/refs/"))
      return Response.json([{ ref: "refs/pull/1/head", object: { sha: headSha } }]);
    return Response.json({ merge_base: baseSha });
  });
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    const diff = yield* provider.getDiff(input);
    assert.deepStrictEqual(diff, { patch, truncated: false, nextCursor: null, snapshot });
    const expand = provider.getDiffFileContents;
    assert.isDefined(expand);
    if (!expand) return;
    const fileInput = {
      ...input,
      snapshot,
      changeType: "change" as const,
      oldPath: "a.ts",
      newPath: "a.ts",
    };
    assert.deepStrictEqual(yield* expand(fileInput), { oldContents: "old", newContents: "new" });
    assert.deepStrictEqual(
      requests
        .filter((request) => request.url.includes("/raw/"))
        .map((request) => new URL(request.url).searchParams.get("ref")),
      [baseSha, headSha],
    );
  }).pipe(Effect.provide(layer));
});
