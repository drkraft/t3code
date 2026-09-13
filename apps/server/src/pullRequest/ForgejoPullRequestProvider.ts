import { Effect } from "effect";
import type { PullRequestCapabilities } from "@t3tools/contracts";
import * as Api from "../sourceControl/ForgejoApi.ts";
import * as Repository from "../sourceControl/forgejoRepository.ts";
import * as Activity from "./ForgejoPullRequestActivity.ts";
import * as Diff from "./ForgejoPullRequestDiff.ts";
import * as Checks from "./ForgejoPullRequestChecks.ts";
import * as Listing from "./ForgejoPullRequestListing.ts";
import * as Review from "./ForgejoPullRequestReview.ts";
import * as Metadata from "./ForgejoPullRequestMetadata.ts";
import * as Permissions from "./ForgejoPullRequestPermissions.ts";
import { PullRequest, actor, repositoryPath, toChangeRequest } from "./forgejoPullRequestJson.ts";
import { PullRequestProviderError, type PullRequestProviderApi } from "./PullRequestProvider.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  search: true,
  comment: true,
  actions: [],
  mergeMethods: [],
  reactions: true,
  review: {
    inlineComment: true,
    reply: true,
    resolve: false,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
  labels: true,
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
  const review = yield* Review.make;
  const metadata = yield* Metadata.make;
  const permissions = yield* Permissions.make;
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
      const requested = yield* metadata
        .listRequestedReviewers(input)
        .pipe(Effect.mapError(fail("getChangeRequest")));
      return {
        ...toChangeRequest(pr),
        body: pr.body,
        changedFiles: pr.changed_files,
        closedAt: pr.closed_at,
        mergedAt: pr.merged_at,
        reviewers: [
          ...requested.users.flatMap((user) => {
            const value = actor(user);
            return value ? [value] : [];
          }),
          ...requested.teams.map((team) => ({
            login: team.name,
            name: team.name,
            avatarUrl: null,
          })),
        ],
        checks: statuses,
        checksState: Checks.checksState(statuses),
        mergeCapabilities: { merge: false, squash: false, rebase: false },
        viewerPermissions: yield* permissions
          .getViewerPermissions(input, pr)
          .pipe(Effect.mapError(fail("getChangeRequest"))),
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
    getViewerPermissions: (input) =>
      permissions.getViewerPermissions(input).pipe(Effect.mapError(fail("getViewerPermissions"))),
    getDiff: (input) => diff.getDiff(input).pipe(Effect.mapError(fail("getDiff"))),
    getDiffFileContents: (input) =>
      diff.getDiffFileContents(input).pipe(Effect.mapError(fail("getDiffFileContents"))),
    runAction: () => unavailable("runAction"),
    comment: (input) => review.comment(input).pipe(Effect.mapError(fail("comment"))),
    updateChangeRequest: (input) =>
      review.updateChangeRequest(input).pipe(Effect.mapError(fail("updateChangeRequest"))),
    updateComment: (input) =>
      review.updateComment(input).pipe(Effect.mapError(fail("updateComment"))),
    submitReview: (input) => review.submitReview(input).pipe(Effect.mapError(fail("submitReview"))),
    listReviewerCandidates: (input) =>
      metadata.listReviewerCandidates(input).pipe(Effect.mapError(fail("listReviewerCandidates"))),
    setReviewerRequest: (input) =>
      metadata.setReviewerRequest(input).pipe(Effect.mapError(fail("setReviewerRequest"))),
    listLabelCandidates: (input) =>
      metadata.listLabelCandidates(input).pipe(Effect.mapError(fail("listLabelCandidates"))),
    setLabels: (input) => metadata.setLabels(input).pipe(Effect.mapError(fail("setLabels"))),
    replyToThread: (input) =>
      review.replyToThread(input).pipe(Effect.mapError(fail("replyToThread"))),
    setReaction: (input) => metadata.setReaction(input).pipe(Effect.mapError(fail("setReaction"))),
    setThreadResolution: () => unavailable("setThreadResolution"),
  };
  return provider;
});
