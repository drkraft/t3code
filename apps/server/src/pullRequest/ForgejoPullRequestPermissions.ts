import type {
  PullRequestAction,
  PullRequestUpdateMethod,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { ForgejoApi } from "../sourceControl/ForgejoApi.ts";
import type { ProviderRepositoryRef } from "./PullRequestProvider.ts";
import { compileForgejoCheckGlob } from "./forgejoCheckGlob.ts";
import { PullRequest, repositoryPath } from "./forgejoPullRequestJson.ts";

const Repository = Schema.Struct({
  archived: Schema.Boolean,
  permissions: Schema.optional(Schema.Struct({ push: Schema.Boolean })),
  allow_merge_commits: Schema.optional(Schema.Boolean),
  allow_squash_merge: Schema.optional(Schema.Boolean),
  allow_rebase: Schema.optional(Schema.Boolean),
  allow_rebase_update: Schema.optional(Schema.Boolean),
  default_merge_style: Schema.optional(Schema.String),
  default_update_style: Schema.optional(Schema.String),
});
const Branch = Schema.Struct({
  protected: Schema.Boolean,
  user_can_merge: Schema.Boolean,
  user_can_push: Schema.Boolean,
  enable_status_check: Schema.Boolean,
  status_check_contexts: Schema.NullOr(Schema.Array(Schema.String)),
  required_approvals: Schema.Int,
});
const Status = Schema.Struct({ context: Schema.String, status: Schema.String });
const Review = Schema.Struct({
  state: Schema.String,
  official: Schema.Boolean,
  dismissed: Schema.Boolean,
});

export const make = Effect.gen(function* () {
  const api = yield* ForgejoApi;
  const read = Effect.fn("ForgejoPullRequestPermissions.read")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
    alreadyReadPullRequest?: typeof PullRequest.Type,
  ) {
    const root = yield* repositoryPath(input);
    const pr =
      alreadyReadPullRequest ??
      (yield* api.request({
        host: input.host,
        path: `${root}/pulls/${input.number}`,
        schema: PullRequest,
      }));
    const viewer = yield* api.getViewer(input.host);
    const repository = yield* api.request({ host: input.host, path: root, schema: Repository });
    const actions: PullRequestAction[] = [];
    const updateMethods: PullRequestUpdateMethod[] = [];
    const mergeCapabilities = {
      merge: repository.allow_merge_commits === true,
      squash: repository.allow_squash_merge === true,
      rebase: repository.allow_rebase === true,
    };
    const prefixes = api.resolveConnection(input.host)?.wipPrefixes;
    if (!repository.archived && !pr.merged) {
      // PR-unit edit rights are not exposed by repository code permissions. Unknown
      // rights remain available under the shared contract and are enforced by Forgejo.
      actions.push(pr.state === "open" ? "close" : "reopen");
      if (pr.state === "open") {
        if (prefixes?.length) actions.push(pr.draft ? "ready" : "draft");
        const base = yield* api.request({
          host: input.host,
          path: `${root}/branches/${encodeURIComponent(pr.base.ref)}`,
          schema: Branch,
        });
        let blocked = !base.user_can_merge || pr.draft || pr.mergeable !== true;
        if (!blocked && base.enable_status_check) {
          const statuses = new Map<string, string>();
          let path: string | null =
            `${root}/statuses/${encodeURIComponent(pr.head.sha)}?sort=recentupdate&limit=50`;
          const pages = new Set<string>();
          while (path !== null && !pages.has(path) && pages.size < 100) {
            pages.add(path);
            const page: {
              readonly items: ReadonlyArray<typeof Status.Type>;
              readonly next: string | null;
            } = yield* api.page({ host: input.host, path, schema: Status });
            for (const status of page.items)
              if (!statuses.has(status.context)) statuses.set(status.context, status.status);
            path = page.next;
          }
          const patterns = (base.status_check_contexts ?? [])
            .map(compileForgejoCheckGlob)
            .filter((pattern) => pattern !== null);
          blocked =
            path !== null ||
            (patterns.length === 0
              ? statuses.size === 0 || [...statuses.values()].some((status) => status !== "success")
              : patterns.some((matches) => {
                  const matching = [...statuses].filter(([context]) => matches(context));
                  return (
                    matching.length === 0 || matching.some(([, status]) => status !== "success")
                  );
                }));
        }
        if (!blocked && base.required_approvals > 0) {
          let approved = 0;
          let path: string | null = `${root}/pulls/${input.number}/reviews?limit=50`;
          const pages = new Set<string>();
          while (path !== null && !pages.has(path) && pages.size < 100) {
            pages.add(path);
            const page: {
              readonly items: ReadonlyArray<typeof Review.Type>;
              readonly next: string | null;
            } = yield* api.page({ host: input.host, path, schema: Review });
            approved += page.items.filter(
              (review) => review.state === "APPROVED" && review.official && !review.dismissed,
            ).length;
            path = page.next;
          }
          blocked = path !== null || approved < base.required_approvals;
        }
        if (!blocked && Object.values(mergeCapabilities).some(Boolean)) actions.push("merge");
        if (pr.head.repo !== null && pr.flow !== 1) {
          const headRoot = yield* repositoryPath({ repository: pr.head.repo.full_name });
          const headRepository =
            pr.head.repo.full_name === input.repository
              ? repository
              : yield* api.request({ host: input.host, path: headRoot, schema: Repository });
          const head = yield* api
            .request({
              host: input.host,
              path: `${headRoot}/branches/${encodeURIComponent(pr.head.ref)}`,
              schema: Branch,
            })
            .pipe(
              Effect.catch((error) =>
                error.reason === "not-found" ? Effect.succeed(null) : Effect.fail(error),
              ),
            );
          if (head !== null && !headRepository.archived) {
            const canUpdate =
              head.user_can_merge ||
              (pr.allow_maintainer_edit === true && repository.permissions?.push !== false);
            if (canUpdate && (!head.protected || head.user_can_push)) updateMethods.push("merge");
            // Forgejo 15.0.8's rebase flag omits its merge permission check; require
            // source editing rights for both update methods before making a request.
            if (canUpdate && !head.protected && headRepository.allow_rebase_update === true)
              updateMethods.push("rebase");
          }
          if (updateMethods.length) actions.push("update-branch");
        }
      }
    }
    const viewerPermissions = {
      actions,
      updateMethods,
      comment: !repository.archived,
      resolve: false,
      verdicts: pr.user?.id === viewer.id ? ["comment"] : ["comment", "approve", "request-changes"],
      requestReviewers: true,
      labels: true,
    } satisfies PullRequestViewerPermissions;
    return { pr, repository, mergeCapabilities, viewerPermissions };
  });
  const getViewerPermissions = Effect.fn("ForgejoPullRequestPermissions.getViewerPermissions")(
    function* (
      input: ProviderRepositoryRef & { readonly number: number },
      alreadyReadPullRequest?: typeof PullRequest.Type,
    ) {
      return (yield* read(input, alreadyReadPullRequest)).viewerPermissions;
    },
  );
  return { read, getViewerPermissions };
});
