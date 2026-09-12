import { Effect } from "effect";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";
import * as Api from "../sourceControl/ForgejoApi.ts";
import * as Repository from "../sourceControl/forgejoRepository.ts";
import * as Activity from "./ForgejoPullRequestActivity.ts";
import * as Diff from "./ForgejoPullRequestDiff.ts";
import * as Checks from "./ForgejoPullRequestChecks.ts";
import * as Listing from "./ForgejoPullRequestListing.ts";
import { PullRequest, actor, repositoryPath, toChangeRequest } from "./forgejoPullRequestJson.ts";
import { PullRequestProviderError, type PullRequestProviderApi } from "./PullRequestProvider.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  search: true,
  comment: false,
  actions: [],
  mergeMethods: [],
  reactions: false,
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: false, comment: false },
};
const PERMISSIONS: PullRequestViewerPermissions = {
  actions: [],
  comment: false,
  resolve: false,
  verdicts: [],
  requestReviewers: false,
};
export const forgejoProviderFailure = (error: Api.ForgejoApiError) => ({
  reason:
    error.reason === "unauthenticated"
      ? ("unauthenticated" as const)
      : error.reason === "rate-limited"
        ? ("rate-limited" as const)
        : ("failed" as const),
  ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
});
const fail = (operation: string) => (error: Api.ForgejoApiError) =>
  new PullRequestProviderError({
    provider: "forgejo",
    operation,
    ...forgejoProviderFailure(error),
    detail: error.detail,
  });
const unavailable = (operation: string) =>
  Effect.fail(
    new PullRequestProviderError({
      provider: "forgejo",
      operation,
      reason: "failed",
      detail: "Forgejo review writes are not implemented yet.",
    }),
  );
export const make = Effect.gen(function* () {
  const api = yield* Api.ForgejoApi;
  const repository = yield* Repository.make;
  const activity = yield* Activity.make;
  const diff = yield* Diff.make;
  const checks = yield* Checks.make;
  const list = yield* Listing.make;
  const get = Effect.fn("ForgejoPullRequestProvider.get")(function* (input: {
    readonly host: string;
    readonly repository: string;
    readonly number: number;
  }) {
    const path = yield* repositoryPath(input);
    return yield* api.request({
      host: input.host,
      path: `${path}/pulls/${input.number}`,
      schema: PullRequest,
    });
  });
  const provider: PullRequestProviderApi = {
    kind: "forgejo",
    capabilities: CAPABILITIES,
    getViewer: Effect.fn("ForgejoPullRequestProvider.getViewer")(function* (input) {
      const ref = yield* repository.resolve(input).pipe(
        Effect.mapError(
          (error) =>
            new PullRequestProviderError({
              provider: "forgejo",
              operation: "getViewer",
              reason: "failed",
              detail:
                error._tag === "ForgejoApiError"
                  ? error.detail
                  : "Unable to identify this workspace's Forgejo connection.",
            }),
        ),
      );
      return (yield* api.getViewer(ref.host).pipe(Effect.mapError(fail("getViewer")))).login;
    }),
    listChangeRequests: (input) => list(input).pipe(Effect.mapError(fail("listChangeRequests"))),
    getChangeRequest: Effect.fn("ForgejoPullRequestProvider.getChangeRequest")(function* (input) {
      const pr = yield* get(input).pipe(Effect.mapError(fail("getChangeRequest")));
      const statuses = yield* checks({ ...input, sha: pr.head.sha }).pipe(
        Effect.mapError(fail("getChangeRequest")),
      );
      return {
        ...toChangeRequest(pr),
        body: pr.body,
        changedFiles: pr.changed_files,
        closedAt: pr.closed_at,
        mergedAt: pr.merged_at,
        reviewers: (pr.requested_reviewers ?? []).flatMap((user) => {
          const value = actor(user);
          return value ? [value] : [];
        }),
        checks: statuses,
        checksState: Checks.checksState(statuses),
        mergeCapabilities: { merge: false, squash: false, rebase: false },
        viewerPermissions: PERMISSIONS,
      };
    }),
    getChangeRequestSummary: (input) =>
      get(input).pipe(
        Effect.mapError(fail("getChangeRequestSummary")),
        Effect.map((pr) => ({ ...toChangeRequest(pr), changedFiles: pr.changed_files })),
      ),
    getChangeRequestActivity: (input) =>
      activity
        .getChangeRequestActivity(input)
        .pipe(Effect.mapError(fail("getChangeRequestActivity"))),
    getViewerPermissions: () => Effect.succeed(PERMISSIONS),
    getDiff: (input) => diff.getDiff(input).pipe(Effect.mapError(fail("getDiff"))),
    getDiffFileContents: (input) =>
      diff.getDiffFileContents(input).pipe(Effect.mapError(fail("getDiffFileContents"))),
    runAction: () => unavailable("runAction"),
    comment: () => unavailable("comment"),
    submitReview: () => unavailable("submitReview"),
    listReviewerCandidates: () => unavailable("listReviewerCandidates"),
    setReviewerRequest: () => unavailable("setReviewerRequest"),
    replyToThread: () => unavailable("replyToThread"),
    setReaction: () => unavailable("setReaction"),
    setThreadResolution: () => unavailable("setThreadResolution"),
  };
  return provider;
});
