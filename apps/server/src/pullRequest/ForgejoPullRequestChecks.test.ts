import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { make } from "./ForgejoPullRequestChecks.ts";
import { harness } from "./forgejoPullRequestTestHarness.ts";

it.effect(
  "ignores old heads and superseded status contexts while retaining approval-required workflows",
  () => {
    const layer = harness((url) =>
      url.pathname.includes("statuses")
        ? Response.json([
            { id: 3, context: "lint", status: "success", description: "", target_url: "" },
            { id: 2, context: "lint", status: "failure", description: "", target_url: "" },
          ])
        : Response.json({
            total_count: 2,
            workflow_runs: [
              {
                id: 3,
                commit_sha: "old",
                workflow_id: "old.yml",
                title: "Old",
                status: "failure",
                html_url: "",
                need_approval: false,
              },
              {
                id: 4,
                commit_sha: "current",
                workflow_id: "test.yml",
                title: "Tests",
                status: "waiting",
                html_url: "",
                need_approval: true,
              },
            ],
          }),
    );
    return Effect.gen(function* () {
      const list = yield* make;
      const checks = yield* list({
        host: "forge.example",
        repository: "team/repo",
        sha: "current",
      });
      assert.deepStrictEqual(
        checks.map(({ name, status }) => ({ name, status })),
        [
          { name: "lint", status: "success" },
          { name: "test.yml", status: "action-required" },
        ],
      );
    }).pipe(Effect.provide(layer));
  },
);
it.effect("selects the latest workflow attempt regardless of response ordering", () => {
  const layer = harness((url) =>
    url.pathname.includes("statuses")
      ? Response.json([])
      : Response.json({
          total_count: 2,
          workflow_runs: [
            {
              id: 2,
              commit_sha: "current",
              workflow_id: "test.yml",
              title: "Old attempt",
              status: "failure",
              html_url: "",
              need_approval: false,
            },
            {
              id: 3,
              commit_sha: "current",
              workflow_id: "test.yml",
              title: "Latest attempt",
              status: "success",
              html_url: "",
              need_approval: false,
            },
          ],
        }),
  );
  return Effect.gen(function* () {
    const list = yield* make;
    const checks = yield* list({ host: "forge.example", repository: "team/repo", sha: "current" });
    assert.strictEqual(checks[0]?.status, "success");
  }).pipe(Effect.provide(layer));
});
