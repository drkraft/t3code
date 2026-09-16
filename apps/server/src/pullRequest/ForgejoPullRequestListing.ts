import { Effect, Schema } from "effect";
import * as Api from "../sourceControl/ForgejoApi.ts";
import type { PullRequestProviderApi, ProviderChangeRequest } from "./PullRequestProvider.ts";
import { PullRequest, repositoryPath, toChangeRequest } from "./forgejoPullRequestJson.ts";
import * as Checks from "./ForgejoPullRequestChecks.ts";

const Issue = Schema.Struct({ number: Schema.Int });
const Review = Schema.Struct({
  id: Schema.Int,
  state: Schema.String,
  stale: Schema.Boolean,
  dismissed: Schema.Boolean,
  official: Schema.Boolean,
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
});
export const make = Effect.gen(function* () {
  const api = yield* Api.ForgejoApi;
  const checks = yield* Checks.make;
  return Effect.fn("ForgejoPullRequestListing.list")(function* (
    input: Parameters<PullRequestProviderApi["listChangeRequests"]>[0],
  ) {
    const root = yield* repositoryPath(input);
    const state = input.state === "merged" ? "closed" : input.state;
    const query = new URLSearchParams({ state, sort: "recentupdate", limit: "50" });
    if (input.query) {
      query.set("q", input.query);
      query.set("type", "pulls");
    }
    let path: string | null = `${root}/${input.query ? "issues" : "pulls"}?${query}`;
    const items: ProviderChangeRequest[] = [];
    const seen = new Set<number>();
    const pages = new Set<string>();
    let matched = 0;
    const skip = input.cursor?.delivered ?? 0;
    while (path !== null && items.length <= input.limit) {
      if (pages.has(path) || pages.size >= 100)
        return yield* new Api.ForgejoApiError({
          reason: "invalid-response",
          detail: "Forgejo listing pagination did not complete.",
        });
      pages.add(path);
      const batch: {
        readonly items: ReadonlyArray<typeof PullRequest.Type | null>;
        readonly next: string | null;
      } = input.query
        ? yield* api.page({ host: input.host, path, schema: Issue }).pipe(
            Effect.flatMap((page) =>
              Effect.forEach(
                page.items,
                (issue) =>
                  api.request({
                    host: input.host,
                    path: `${root}/pulls/${issue.number}`,
                    schema: PullRequest,
                  }),
                { concurrency: 4 },
              ).pipe(Effect.map((rows) => ({ items: rows, next: page.next }))),
            ),
          )
        : yield* api.page({ host: input.host, path, schema: Schema.NullOr(PullRequest) });
      for (const pr of batch.items) {
        if (pr === null || seen.has(pr.number)) continue;
        seen.add(pr.number);
        let row = toChangeRequest(pr);
        if (input.state !== "all" && row.state !== input.state) continue;
        const author = row.author?.login.toLowerCase();
        const viewer = input.viewer.toLowerCase();
        if (input.involvement === "authored" && author !== viewer) continue;
        if (
          input.involvement === "reviewing" &&
          !row.reviewRequestLogins.some((login) => login.toLowerCase() === viewer)
        )
          continue;
        const filters = input.filters;
        if (filters?.draft && row.isDraft !== (filters.draft === "only")) continue;
        const wantedAuthor = filters?.author === "@me" ? viewer : filters?.author?.toLowerCase();
        if (wantedAuthor && author !== wantedAuthor) continue;
        const labels = new Set(row.labels.map((label) => label.name.toLowerCase()));
        if (
          filters?.labels?.some((group) => !group.some((label) => labels.has(label.toLowerCase())))
        )
          continue;
        if (filters?.excludedLabels?.some((label) => labels.has(label.toLowerCase()))) continue;
        if (filters?.review) {
          const reviews = new Map<string, typeof Review.Type>();
          let reviewsPath: string | null = `${root}/pulls/${pr.number}/reviews?limit=50`;
          const reviewPages = new Set<string>();
          while (reviewsPath) {
            if (reviewPages.has(reviewsPath) || reviewPages.size >= 100)
              return yield* new Api.ForgejoApiError({
                reason: "invalid-response",
                detail: "Forgejo review pagination did not complete.",
              });
            reviewPages.add(reviewsPath);
            const page: {
              readonly items: ReadonlyArray<typeof Review.Type>;
              readonly next: string | null;
            } = yield* api.page({ host: input.host, path: reviewsPath, schema: Review });
            for (const review of page.items) {
              if (
                review.user &&
                review.state !== "COMMENT" &&
                review.state !== "PENDING" &&
                review.id > (reviews.get(review.user.login)?.id ?? -1)
              )
                reviews.set(review.user.login, review);
            }
            reviewsPath = page.next;
          }
          const branch = yield* api.request({
            host: input.host,
            path: `${root}/branches/${encodeURIComponent(pr.base.ref)}`,
            schema: Schema.Struct({ required_approvals: Schema.Int }),
          });
          const decisions = [...reviews.values()].filter(
            (review) => review.official && !review.stale && !review.dismissed,
          );
          const approvals = decisions.filter((review) => review.state === "APPROVED").length;
          const reviewDecision = decisions.some((review) => review.state === "REQUEST_CHANGES")
            ? ("changes-requested" as const)
            : approvals > 0 && approvals >= branch.required_approvals
              ? ("approved" as const)
              : branch.required_approvals > approvals || row.reviewRequestLogins.length > 0
                ? ("review-required" as const)
                : null;
          row = { ...row, reviewDecision };
          if ((filters.review === "none" ? null : filters.review) !== reviewDecision) continue;
        }
        if (filters?.checks) {
          const checksState = Checks.checksState(yield* checks({ ...input, sha: pr.head.sha }));
          row = { ...row, checksState };
          if (checksState !== filters.checks) continue;
        }
        if (matched++ < skip) continue;
        items.push(row);
        if (items.length > input.limit) break;
      }
      path = batch.next;
    }
    return {
      items: items.slice(0, input.limit),
      truncated: items.length > input.limit,
      cursorAdvance: Math.min(items.length, input.limit),
      continues: true,
    };
  });
});
