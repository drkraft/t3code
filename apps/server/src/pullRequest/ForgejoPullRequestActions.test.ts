import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { harness } from "../sourceControl/ForgejoApi.testSupport.ts";
import { pullRequestFixture } from "./forgejoPullRequestTestHarness.ts";
import * as Permissions from "./ForgejoPullRequestPermissions.ts";
import * as Actions from "./ForgejoPullRequestActions.ts";

const input = { cwd: "/repo", host: "forge.example", repository: "team/repo", number: 1 };
const sha = "a".repeat(40);
const pr = {
  ...pullRequestFixture,
  head: { ref: "feature", sha, repo: { full_name: "team/repo" } },
};
const repository = {
  archived: false,
  allow_merge_commits: true,
  allow_squash_merge: true,
  allow_rebase: true,
  allow_rebase_update: true,
  default_merge_style: "merge",
  default_update_style: "merge",
};
const branch = {
  protected: false,
  user_can_merge: true,
  user_can_push: true,
  enable_status_check: false,
  status_check_contexts: [],
  required_approvals: 0,
};
const decodeBody = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

for (const mergeMethod of ["merge", "squash", "rebase"] as const) {
  it.effect(`merges with ${mergeMethod} at the expected head and confirms server state`, () => {
    let merged = false;
    const { layer, execute } = harness((request) => {
      if (request.method === "POST") {
        merged = true;
        return new Response(null, { status: 204 });
      }
      return Response.json(
        request.url.endsWith("/user")
          ? { id: 3, login: "alice" }
          : request.url.includes("/branches/")
            ? branch
            : request.url.endsWith("/pulls/1")
              ? { ...pr, merged, state: merged ? "closed" : "open" }
              : repository,
      );
    });
    return Effect.gen(function* () {
      const actions = yield* Actions.make;
      yield* actions.runAction({ ...input, action: "merge", mergeMethod, expectedHeadSha: sha });
      const writes = execute.mock.calls.filter(([r]) => r.method === "POST");
      assert.strictEqual(writes.length, 1);
      const request = writes[0]?.[0];
      if (request?.body._tag === "Uint8Array")
        assert.deepStrictEqual(yield* decodeBody(new TextDecoder().decode(request.body.body)), {
          Do: mergeMethod,
          head_commit_id: sha,
          delete_branch_after_merge: false,
          merge_when_checks_succeed: false,
          force_merge: false,
        });
      assert.isTrue(execute.mock.calls.at(-1)?.[0].url.endsWith("/pulls/1"));
    }).pipe(Effect.provide(layer));
  });
}

for (const scenario of [
  "missing",
  "stale",
  "invalid",
  "conflict",
  "denied",
  "closed",
  "draft",
  "merged",
  "disabled-style",
  "red-check",
  "missing-check",
  "missing-approval",
] as const) {
  it.effect(`refuses merge before writing when ${scenario}`, () => {
    const { layer, execute } = harness((request) =>
      Response.json(
        request.url.endsWith("/user")
          ? { id: 3, login: "alice" }
          : request.url.includes("/statuses/")
            ? [{ context: "ci", status: "failure" }]
            : request.url.includes("/reviews?")
              ? []
              : request.url.includes("/branches/")
                ? {
                    ...branch,
                    user_can_merge: scenario !== "denied",
                    enable_status_check: scenario === "red-check" || scenario === "missing-check",
                    status_check_contexts: [scenario === "missing-check" ? "missing" : "ci"],
                    required_approvals: scenario === "missing-approval" ? 1 : 0,
                  }
                : request.url.endsWith("/pulls/1")
                  ? {
                      ...pr,
                      mergeable: scenario !== "conflict",
                      draft: scenario === "draft",
                      merged: scenario === "merged",
                      state: scenario === "closed" ? "closed" : "open",
                    }
                  : { ...repository, allow_merge_commits: scenario !== "disabled-style" },
      ),
    );
    return Effect.gen(function* () {
      const actions = yield* Actions.make;
      yield* actions
        .runAction({
          ...input,
          action: "merge",
          mergeMethod: "merge",
          ...(scenario === "missing"
            ? {}
            : {
                expectedHeadSha:
                  scenario === "stale" ? "b".repeat(40) : scenario === "invalid" ? "main" : sha,
              }),
        })
        .pipe(Effect.flip);
      assert.strictEqual(execute.mock.calls.filter(([r]) => r.method !== "GET").length, 0);
    }).pipe(Effect.provide(layer));
  });
}

for (const status of [403, 405, 409, 500]) {
  it.effect(`propagates ${status} and never repeats a write`, () => {
    const { layer, execute } = harness((request) =>
      request.method === "POST"
        ? new Response(null, { status })
        : Response.json(
            request.url.endsWith("/user")
              ? { id: 3, login: "alice" }
              : request.url.includes("/branches/")
                ? branch
                : request.url.endsWith("/pulls/1")
                  ? pr
                  : repository,
          ),
    );
    return Effect.gen(function* () {
      const actions = yield* Actions.make;
      const error = yield* actions
        .runAction({ ...input, action: "merge", expectedHeadSha: sha })
        .pipe(Effect.flip);
      assert.strictEqual(error.status, status);
      assert.strictEqual(execute.mock.calls.filter(([r]) => r.method === "POST").length, 1);
    }).pipe(Effect.provide(layer));
  });
}

for (const updateMethod of ["merge", "rebase"] as const) {
  it.effect(`updates the branch using ${updateMethod}`, () => {
    const { layer, execute } = harness((request) =>
      request.method === "POST"
        ? new Response("", { status: 200 })
        : Response.json(
            request.url.endsWith("/user")
              ? { id: 3, login: "alice" }
              : request.url.includes("/branches/")
                ? branch
                : request.url.endsWith("/pulls/1")
                  ? pr
                  : repository,
          ),
    );
    return Effect.gen(function* () {
      const actions = yield* Actions.make;
      yield* actions.runAction({
        ...input,
        action: "update-branch",
        updateMethod,
        expectedHeadSha: sha,
      });
      assert.isTrue(
        execute.mock.calls
          .find(([r]) => r.method === "POST")?.[0]
          .url.endsWith(`/update?style=${updateMethod}`),
      );
    }).pipe(Effect.provide(layer));
  });
}

for (const action of ["close", "reopen", "draft", "ready"] as const) {
  it.effect(`confirms ${action} through a fresh PR read`, () => {
    let changed = false;
    const { layer, execute } = harness(
      (request) => {
        if (request.method === "PATCH") {
          changed = true;
          return Response.json({});
        }
        return Response.json(
          request.url.endsWith("/user")
            ? { id: 3, login: "alice" }
            : request.url.includes("/branches/")
              ? branch
              : request.url.endsWith("/pulls/1")
                ? {
                    ...pr,
                    title: action === "ready" ? "wip: [wIP] Change" : "Change",
                    state:
                      action === "reopen"
                        ? changed
                          ? "open"
                          : "closed"
                        : action === "close" && changed
                          ? "closed"
                          : "open",
                    draft: action === "draft" ? changed : action === "ready" && !changed,
                  }
                : repository,
        );
      },
      {
        ONE_TOKEN: "fixture",
        T3CODE_FORGEJO_CONNECTIONS: JSON.stringify([
          {
            id: "one",
            apiUrl: "https://forge.example/api/v1",
            gitHosts: [],
            tokenEnv: "ONE_TOKEN",
            wipPrefixes: ["WIP:", "[WIP]"],
          },
        ]),
      },
    );
    return Effect.gen(function* () {
      const actions = yield* Actions.make;
      yield* actions.runAction({ ...input, action });
      const request = execute.mock.calls.find(([r]) => r.method === "PATCH")?.[0];
      if (request?.body._tag === "Uint8Array")
        assert.deepStrictEqual(
          yield* decodeBody(new TextDecoder().decode(request.body.body)),
          action === "draft"
            ? { title: "WIP: Change" }
            : action === "ready"
              ? { title: "Change" }
              : { state: action === "close" ? "closed" : "open" },
        );
      assert.isTrue(execute.mock.calls.at(-1)?.[0].url.endsWith("/pulls/1"));
    }).pipe(Effect.provide(layer));
  });
}

it.effect("rejects a successful write whose expected state is not confirmed", () => {
  const { layer, execute } = harness((request) =>
    request.method === "POST"
      ? new Response(null, { status: 204 })
      : Response.json(
          request.url.endsWith("/user")
            ? { id: 3, login: "alice" }
            : request.url.includes("/branches/")
              ? branch
              : request.url.endsWith("/pulls/1")
                ? pr
                : repository,
        ),
  );
  return Effect.gen(function* () {
    const actions = yield* Actions.make;
    yield* actions.runAction({ ...input, action: "merge", expectedHeadSha: sha }).pipe(Effect.flip);
    assert.strictEqual(execute.mock.calls.filter(([r]) => r.method === "POST").length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("reloads revoked branch merge permission before a mutation", () => {
  let allowed = true;
  const { layer, execute } = harness((request) =>
    Response.json(
      request.url.endsWith("/user")
        ? { id: 3, login: "alice" }
        : request.url.includes("/branches/")
          ? { ...branch, user_can_merge: allowed }
          : request.url.endsWith("/pulls/1")
            ? pr
            : repository,
    ),
  );
  return Effect.gen(function* () {
    const permissions = yield* Permissions.make;
    assert.include((yield* permissions.getViewerPermissions(input)).actions, "merge");
    allowed = false;
    const actions = yield* Actions.make;
    yield* actions.runAction({ ...input, action: "merge", expectedHeadSha: sha }).pipe(Effect.flip);
    assert.strictEqual(execute.mock.calls.filter(([r]) => r.method === "POST").length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("does not interpret a glob as a missing literal status", () => {
  const { layer } = harness((request) =>
    Response.json(
      request.url.endsWith("/user")
        ? { id: 3, login: "alice" }
        : request.url.includes("/statuses/")
          ? [{ context: "ci/unit", status: "success" }]
          : request.url.includes("/branches/")
            ? { ...branch, enable_status_check: true, status_check_contexts: ["ci/*"] }
            : request.url.endsWith("/pulls/1")
              ? pr
              : repository,
    ),
  );
  return Effect.gen(function* () {
    const permissions = yield* Permissions.make;
    assert.include((yield* permissions.getViewerPermissions(input)).actions, "merge");
  }).pipe(Effect.provide(layer));
});

for (const scenario of [
  { contexts: ["ci/*"], statuses: [{ context: "ci/unit", status: "failure" }] },
  { contexts: ["ci/*"], statuses: [{ context: "lint", status: "success" }] },
  {
    contexts: ["ci/*"],
    statuses: [
      { context: "ci/unit", status: "success" },
      { context: "ci/e2e", status: "pending" },
    ],
  },
  { contexts: ["["], statuses: [{ context: "lint", status: "failure" }] },
]) {
  it.effect(`blocks unsatisfied required status policy ${JSON.stringify(scenario)}`, () => {
    const { layer } = harness((request) =>
      Response.json(
        request.url.endsWith("/user")
          ? { id: 3, login: "alice" }
          : request.url.includes("/statuses/")
            ? scenario.statuses
            : request.url.includes("/branches/")
              ? { ...branch, enable_status_check: true, status_check_contexts: scenario.contexts }
              : request.url.endsWith("/pulls/1")
                ? pr
                : repository,
      ),
    );
    return Effect.gen(function* () {
      const permissions = yield* Permissions.make;
      assert.notInclude((yield* permissions.getViewerPermissions(input)).actions, "merge");
    }).pipe(Effect.provide(layer));
  });
}

for (const action of [
  "draft",
  "ready",
  "enable-auto-merge",
  "disable-auto-merge",
  "revert",
  "approve-workflows",
] as const) {
  it.effect(`does not write unsupported or unconfigured ${action}`, () => {
    const { layer, execute } = harness((request) =>
      Response.json(
        request.url.endsWith("/user")
          ? { id: 3, login: "alice" }
          : request.url.includes("/branches/")
            ? branch
            : request.url.endsWith("/pulls/1")
              ? pr
              : repository,
      ),
    );
    return Effect.gen(function* () {
      const actions = yield* Actions.make;
      yield* actions.runAction({ ...input, action }).pipe(Effect.flip);
      assert.strictEqual(execute.mock.calls.filter(([r]) => r.method !== "GET").length, 0);
    }).pipe(Effect.provide(layer));
  });
}

it.effect("keeps literal required checks enforced alongside glob contexts", () => {
  const { layer } = harness((request) =>
    Response.json(
      request.url.endsWith("/user")
        ? { id: 3, login: "alice" }
        : request.url.includes("/statuses/")
          ? [
              { context: "ci/unit", status: "success" },
              { context: "lint", status: "failure" },
            ]
          : request.url.includes("/branches/")
            ? { ...branch, enable_status_check: true, status_check_contexts: ["ci/*", "lint"] }
            : request.url.endsWith("/pulls/1")
              ? pr
              : repository,
    ),
  );
  return Effect.gen(function* () {
    const permissions = yield* Permissions.make;
    assert.notInclude((yield* permissions.getViewerPermissions(input)).actions, "merge");
  }).pipe(Effect.provide(layer));
});

for (const scenario of [
  "stale-update",
  "missing-update",
  "protected-rebase",
  "disabled-rebase",
  "deleted-head",
  "agit",
] as const) {
  it.effect(`does not write an update with ${scenario}`, () => {
    const { layer, execute } = harness((request) =>
      request.url.includes("/branches/feature") && scenario === "deleted-head"
        ? new Response(null, { status: 404 })
        : Response.json(
            request.url.endsWith("/user")
              ? { id: 3, login: "alice" }
              : request.url.includes("/branches/")
                ? { ...branch, protected: scenario === "protected-rebase" }
                : request.url.endsWith("/pulls/1")
                  ? { ...pr, flow: scenario === "agit" ? 1 : 0 }
                  : { ...repository, allow_rebase_update: scenario !== "disabled-rebase" },
          ),
    );
    return Effect.gen(function* () {
      const actions = yield* Actions.make;
      yield* actions
        .runAction({
          ...input,
          action: "update-branch",
          updateMethod: "rebase",
          ...(scenario === "missing-update"
            ? {}
            : { expectedHeadSha: scenario === "stale-update" ? "b".repeat(40) : sha }),
        })
        .pipe(Effect.flip);
      assert.strictEqual(execute.mock.calls.filter(([r]) => r.method !== "GET").length, 0);
    }).pipe(Effect.provide(layer));
  });
}

it.effect("does not repeat a merge when its confirmation read is lost", () => {
  let written = false;
  const { layer, execute } = harness((request) => {
    if (request.method === "POST") {
      written = true;
      return new Response(null, { status: 204 });
    }
    if (written) return new Response(null, { status: 503 });
    return Response.json(
      request.url.endsWith("/user")
        ? { id: 3, login: "alice" }
        : request.url.includes("/branches/")
          ? branch
          : request.url.endsWith("/pulls/1")
            ? pr
            : repository,
    );
  });
  return Effect.gen(function* () {
    const actions = yield* Actions.make;
    yield* actions.runAction({ ...input, action: "merge", expectedHeadSha: sha }).pipe(Effect.flip);
    assert.strictEqual(execute.mock.calls.filter(([r]) => r.method === "POST").length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses rebase updates without source edit or maintainer permission", () => {
  const { layer, execute } = harness((request) =>
    Response.json(
      request.url.endsWith("/user")
        ? { id: 8, login: "reader" }
        : request.url.includes("/branches/")
          ? { ...branch, user_can_merge: false, user_can_push: false }
          : request.url.endsWith("/pulls/1")
            ? { ...pr, allow_maintainer_edit: false }
            : { ...repository, permissions: { push: false } },
    ),
  );
  return Effect.gen(function* () {
    const permissions = yield* Permissions.make;
    assert.notInclude(
      (yield* permissions.getViewerPermissions(input)).updateMethods ?? [],
      "rebase",
    );
    const actions = yield* Actions.make;
    yield* actions
      .runAction({
        ...input,
        action: "update-branch",
        updateMethod: "rebase",
        expectedHeadSha: sha,
      })
      .pipe(Effect.flip);
    assert.strictEqual(execute.mock.calls.filter(([r]) => r.method === "POST").length, 0);
  }).pipe(Effect.provide(layer));
});
