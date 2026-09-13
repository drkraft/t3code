import type { PullRequestViewerPermissions } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { ForgejoApi } from "../sourceControl/ForgejoApi.ts";
import type { ProviderRepositoryRef } from "./PullRequestProvider.ts";
import { Actor, repositoryPath } from "./forgejoPullRequestJson.ts";

const PermissionPullRequest = Schema.Struct({ user: Schema.NullOr(Actor) });
const Repository = Schema.Struct({ archived: Schema.Boolean });

export const make = Effect.gen(function* () {
  const api = yield* ForgejoApi;
  const getViewerPermissions = Effect.fn("ForgejoPullRequestPermissions.getViewerPermissions")(
    function* (
      input: ProviderRepositoryRef & { readonly number: number },
      alreadyReadPullRequest?: typeof PermissionPullRequest.Type,
    ) {
      const root = yield* repositoryPath(input);
      const pr =
        alreadyReadPullRequest ??
        (yield* api.request({
          host: input.host,
          path: `${root}/pulls/${input.number}`,
          schema: PermissionPullRequest,
        }));
      const viewer = yield* api.getViewer(input.host);
      const repository = yield* api.request({ host: input.host, path: root, schema: Repository });
      // Forgejo 15.0.8 exposes code permissions, not the PR-unit rights used for labels
      // and locked comments, or collaborator/team membership used for review requests.
      // The shared contract grants unknown rights; each mutation remains server-authorized.
      // Only issue-comment creation has archived middleware; review/label routes do not.
      return {
        actions: [],
        comment: !repository.archived,
        resolve: false,
        verdicts:
          pr.user?.id === viewer.id ? ["comment"] : ["comment", "approve", "request-changes"],
        requestReviewers: true,
        labels: true,
      } satisfies PullRequestViewerPermissions;
    },
  );
  return { getViewerPermissions };
});
