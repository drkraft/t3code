import { Effect, Schema } from "effect";
import { ForgejoApi, ForgejoApiError } from "../sourceControl/ForgejoApi.ts";
import type { PullRequestProviderApi } from "./PullRequestProvider.ts";
import * as Permissions from "./ForgejoPullRequestPermissions.ts";
import { PullRequest, repositoryPath } from "./forgejoPullRequestJson.ts";

const failure = (detail: string) => new ForgejoApiError({ reason: "invalid-response", detail });
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeBody = (body: unknown) =>
  encodeJson(body).pipe(Effect.mapError(() => failure("Unable to encode the Forgejo action.")));
export const make = Effect.gen(function* () {
  const api = yield* ForgejoApi;
  const permissions = yield* Permissions.make;
  const runAction = Effect.fn("ForgejoPullRequestActions.runAction")(
    function* (input: Parameters<PullRequestProviderApi["runAction"]>[0]) {
      const { pr, repository, mergeCapabilities, viewerPermissions } =
        yield* permissions.read(input);
      if (!viewerPermissions.actions.includes(input.action))
        return yield* failure(
          "This Forgejo action is unavailable. Refresh the pull request and check its permissions.",
        );
      const root = yield* repositoryPath(input);
      const path = `${root}/pulls/${input.number}`;
      if (input.action === "merge" || input.action === "update-branch") {
        if (
          !input.expectedHeadSha ||
          !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(input.expectedHeadSha) ||
          input.expectedHeadSha !== pr.head.sha
        )
          return yield* failure(
            "The pull request head changed or was not captured. Refresh before trying this action.",
          );
      }
      const write = { host: input.host, schema: Schema.Void };
      switch (input.action) {
        case "merge": {
          const method = input.mergeMethod ?? repository.default_merge_style;
          if (
            (method !== "merge" && method !== "squash" && method !== "rebase") ||
            !mergeCapabilities[method]
          )
            return yield* failure("Select a merge method allowed by this Forgejo repository.");
          yield* api.request({
            ...write,
            path: `${path}/merge`,
            method: "POST",
            body: yield* encodeBody({
              Do: method,
              head_commit_id: input.expectedHeadSha,
              delete_branch_after_merge: false,
              merge_when_checks_succeed: false,
              force_merge: false,
            }),
          });
          break;
        }
        case "update-branch": {
          const method = input.updateMethod ?? repository.default_update_style ?? "merge";
          if (
            (method !== "merge" && method !== "rebase") ||
            !viewerPermissions.updateMethods.includes(method)
          )
            return yield* failure("Select an update method allowed by this Forgejo repository.");
          yield* api.request({ ...write, path: `${path}/update?style=${method}`, method: "POST" });
          break;
        }
        case "close":
        case "reopen":
          yield* api.request({
            ...write,
            schema: Schema.Unknown,
            path,
            method: "PATCH",
            body: yield* encodeBody({ state: input.action === "close" ? "closed" : "open" }),
          });
          break;
        case "draft":
        case "ready": {
          const prefixes = api.resolveConnection(input.host)?.wipPrefixes;
          const prefix = prefixes?.[0];
          if (!prefix)
            return yield* failure(
              "Configure this Forgejo instance's effective WIP prefixes first.",
            );
          let title = pr.title;
          if (input.action === "draft") title = `${prefix} ${title}`;
          else {
            while (true) {
              const match = prefixes.find((candidate) =>
                title.toLowerCase().startsWith(candidate.toLowerCase()),
              );
              if (!match) break;
              title = title.slice(match.length).trimStart();
            }
            if (!title) return yield* failure("The ready pull request needs a nonempty title.");
          }
          yield* api.request({
            ...write,
            schema: Schema.Unknown,
            path,
            method: "PATCH",
            body: yield* encodeBody({ title }),
          });
          break;
        }
        default:
          return yield* failure("This Forgejo action is not supported.");
      }
      const result = yield* api.request({ host: input.host, path, schema: PullRequest });
      const confirmed =
        input.action === "merge"
          ? result.merged
          : input.action === "close"
            ? result.state === "closed" && !result.merged
            : input.action === "reopen"
              ? result.state === "open" && !result.merged
              : input.action === "draft"
                ? result.draft
                : input.action === "ready"
                  ? !result.draft
                  : result.state === "open" && !result.merged;
      if (!confirmed)
        return yield* failure(
          "Forgejo did not confirm the requested state. Inspect the pull request before retrying.",
        );
    },
    Effect.mapError(
      (error) =>
        new ForgejoApiError({
          ...error,
          detail: `${error.detail} No automatic retry was made; inspect Forgejo before repeating a write.`,
        }),
    ),
  );
  return { runAction };
});
