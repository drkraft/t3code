import { Effect, Schema } from "effect";
import type { PullRequestCheck } from "@t3tools/contracts";
import * as Api from "../sourceControl/ForgejoApi.ts";
import { repositoryPath } from "./forgejoPullRequestJson.ts";

const Status = Schema.Struct({
  id: Schema.Int,
  context: Schema.String,
  status: Schema.String,
  description: Schema.String,
  target_url: Schema.String,
});
const Run = Schema.Struct({
  id: Schema.Int,
  commit_sha: Schema.String,
  workflow_id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  html_url: Schema.String,
  need_approval: Schema.Boolean,
});
export const checkStatus = (status: string): PullRequestCheck["status"] => {
  switch (status) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "blocked":
      return "action-required";
    default:
      return "pending";
  }
};
export const checksState = (checks: ReadonlyArray<PullRequestCheck>) =>
  checks.length === 0
    ? null
    : checks.some((check) => check.status === "failure" || check.status === "cancelled")
      ? ("failing" as const)
      : checks.some((check) => check.status === "pending" || check.status === "action-required")
        ? ("pending" as const)
        : ("passing" as const);
export const make = Effect.gen(function* () {
  const api = yield* Api.ForgejoApi;
  return Effect.fn("ForgejoPullRequestChecks.list")(function* (input: {
    readonly host: string;
    readonly repository: string;
    readonly sha: string;
  }) {
    const root = yield* repositoryPath(input);
    const checks: PullRequestCheck[] = [];
    const contexts = new Set<string>();
    const pages = new Set<string>();
    let path: string | null =
      `${root}/statuses/${encodeURIComponent(input.sha)}?sort=recentupdate&limit=50`;
    while (path !== null) {
      if (pages.has(path) || pages.size >= 100)
        return yield* new Api.ForgejoApiError({
          reason: "invalid-response",
          detail: "Forgejo status pagination did not complete.",
        });
      pages.add(path);
      const page: {
        readonly items: ReadonlyArray<typeof Status.Type>;
        readonly next: string | null;
      } = yield* api.page({ host: input.host, path, schema: Status });
      for (const status of page.items) {
        if (contexts.has(status.context)) continue;
        contexts.add(status.context);
        checks.push({
          name: status.context || "Status",
          status: checkStatus(status.status),
          description: status.description || null,
          url: status.target_url || null,
        });
      }
      path = page.next;
    }
    let page = 1;
    const workflows = new Map<string, typeof Run.Type>();
    let consumed = 0;
    while (true) {
      const result = yield* api
        .request({
          host: input.host,
          path: `${root}/actions/runs?head_sha=${encodeURIComponent(input.sha)}&limit=50&page=${page}`,
          schema: Schema.Struct({
            total_count: Schema.Int,
            workflow_runs: Schema.NullOr(Schema.Array(Run)),
          }),
        })
        .pipe(
          Effect.catch((error) =>
            error.reason === "not-found" ? Effect.succeed(null) : Effect.fail(error),
          ),
        );
      if (result === null) break;
      const runs = result.workflow_runs ?? [];
      for (const run of runs) {
        if (run.commit_sha === input.sha && run.id > (workflows.get(run.workflow_id)?.id ?? -1)) {
          workflows.set(run.workflow_id, run);
        }
      }
      consumed += runs.length;
      if (consumed >= result.total_count) break;
      if (runs.length === 0 || page >= 100)
        return yield* new Api.ForgejoApiError({
          reason: "invalid-response",
          detail: "Forgejo workflow pagination did not complete.",
        });
      page += 1;
    }
    for (const run of workflows.values()) {
      checks.push({
        name: run.workflow_id || run.title || "Workflow",
        status: run.need_approval ? "action-required" : checkStatus(run.status),
        description: run.title || null,
        url: run.html_url || null,
      });
    }
    return checks;
  });
});
