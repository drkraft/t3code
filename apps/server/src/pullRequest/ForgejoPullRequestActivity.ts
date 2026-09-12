import { Effect, Schema } from "effect";
import type { PullRequestComment, PullRequestReviewThread } from "@t3tools/contracts";
import type {
  ProviderChangeRequestActivity,
  ProviderRepositoryRef,
} from "./PullRequestProvider.ts";
import { ForgejoApi, ForgejoApiError } from "../sourceControl/ForgejoApi.ts";
import { actor, repositoryPath } from "./forgejoPullRequestJson.ts";
import {
  Comment,
  Commit,
  Reaction,
  Review,
  ReviewComment,
  reactions,
  threadIdentity,
} from "./forgejoActivityJson.ts";

export const make = Effect.gen(function* () {
  const api = yield* ForgejoApi;
  const allPages = <S extends Schema.Top>(input: {
    readonly host: string;
    readonly path: string;
    readonly schema: S;
    readonly allowNullItems?: boolean;
  }) =>
    Effect.gen(function* () {
      const items: Array<S["Type"]> = [];
      const visited = new Set<string>();
      let path: string | null = input.path;
      while (path !== null) {
        if (visited.has(path) || visited.size >= 100)
          return yield* new ForgejoApiError({
            reason: "invalid-response",
            detail: "Forgejo activity pagination did not finish within 100 pages.",
          });
        visited.add(path);
        const page: { readonly items: ReadonlyArray<S["Type"]>; readonly next: string | null } =
          yield* api.page({ ...input, path });
        items.push(...page.items);
        path = page.next;
      }
      return items;
    });
  const getChangeRequestActivity = Effect.fn("ForgejoPullRequestActivity.getChangeRequestActivity")(
    function* (
      input: ProviderRepositoryRef & { readonly number: number },
    ): Effect.fn.Return<ProviderChangeRequestActivity, ForgejoApiError> {
      const root = yield* repositoryPath(input);
      const viewer = yield* api.getViewer(input.host);
      const issue = `${root}/issues/${input.number}`;
      const pull = `${root}/pulls/${input.number}`;
      const [rawComments, rawReviews, rawCommits, rawReactions] = yield* Effect.all(
        [
          allPages({ host: input.host, path: `${issue}/comments?limit=50`, schema: Comment }),
          allPages({ host: input.host, path: `${pull}/reviews?limit=50`, schema: Review }),
          allPages({ host: input.host, path: `${pull}/commits?limit=50`, schema: Commit }),
          allPages({
            host: input.host,
            path: `${issue}/reactions?limit=50`,
            schema: Reaction,
            allowNullItems: true,
          }),
        ],
        { concurrency: 4 },
      );
      const comments = [...new Map(rawComments.map((row) => [row.id, row])).values()];
      const reviews = [...new Map(rawReviews.map((row) => [row.id, row])).values()].filter(
        (row) => row.state !== "PENDING" || row.user?.id === viewer.id,
      );
      const codeComments = (yield* Effect.forEach(
        reviews.filter((row) => row.comments_count > 0),
        (review) =>
          api.request({
            host: input.host,
            path: `${pull}/reviews/${review.id}/comments`,
            schema: Schema.NullOr(Schema.Array(ReviewComment)),
          }),
        { concurrency: 4 },
      )).flatMap((rows) => rows ?? []);
      const conversation: PullRequestComment[] = [
        ...comments.map((row): PullRequestComment => ({
          id: String(row.id),
          kind: "issue-comment",
          author: actor(row.user),
          body: row.body,
          createdAt: row.created_at,
          url: row.html_url || null,
          path: null,
          reviewState: null,
        })),
        ...reviews
          .filter((row) => row.state !== "REQUEST_REVIEW")
          .map((row): PullRequestComment => ({
            id: /#issuecomment-(\d+)$/u.exec(row.html_url)?.[1] ?? `review:${row.id}`,
            kind: "review",
            author: actor(row.user),
            body: row.body,
            createdAt: row.submitted_at,
            url: row.html_url || null,
            path: null,
            reviewState: row.dismissed ? "DISMISSED" : row.state,
          })),
        ...[...new Map(codeComments.map((row) => [row.id, row])).values()].map(
          (row): PullRequestComment => ({
            id: String(row.id),
            kind: "review-comment",
            author: actor(row.user),
            body: row.body,
            createdAt: row.created_at,
            url: row.html_url || null,
            path: row.path,
            reviewState: null,
          }),
        ),
      ];
      const withReactions = yield* Effect.forEach(
        conversation,
        (row) =>
          /^\d+$/u.test(row.id)
            ? api
                .request({
                  host: input.host,
                  path: `${root}/issues/comments/${row.id}/reactions`,
                  schema: Schema.NullOr(Schema.Array(Reaction)),
                })
                .pipe(
                  Effect.map((rows) => ({
                    ...row,
                    reactions: reactions(rows ?? [], viewer.login),
                  })),
                )
            : Effect.succeed(row),
        { concurrency: 4 },
      );
      const byComment = new Map(withReactions.map((row) => [row.id, row]));
      const groups = new Map<string, Array<typeof ReviewComment.Type>>();
      const identity = { ...input, host: api.resolveConnection(input.host)?.apiUrl ?? input.host };
      for (const row of new Map(codeComments.map((comment) => [comment.id, comment])).values()) {
        const id = threadIdentity(identity, row);
        const group = groups.get(id) ?? [];
        group.push(row);
        groups.set(id, group);
      }
      const reviewThreads: PullRequestReviewThread[] = [];
      for (const [id, rows] of groups) {
        rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
        const first = rows[0];
        if (!first) continue;
        reviewThreads.push({
          id,
          path: first.path,
          line: first.position || first.original_position || null,
          side: first.position > 0 ? "right" : "left",
          isResolved: first.resolver !== null,
          isOutdated: null,
          comments: rows.flatMap((row) => {
            const comment = byComment.get(String(row.id));
            return comment ? [comment] : [];
          }),
          commentCount: rows.length,
        });
      }
      return {
        comments: withReactions.sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
        commentCount: Math.max(
          withReactions.length,
          comments.length +
            reviews.filter((row) => row.state !== "REQUEST_REVIEW").length +
            reviews.reduce((sum, row) => sum + row.comments_count, 0),
        ),
        commentsTruncated:
          codeComments.length < reviews.reduce((sum, row) => sum + row.comments_count, 0),
        reviewThreads,
        commits: [...new Map(rawCommits.map((row) => [row.sha, row])).values()]
          .map((row) => ({
            oid: row.sha,
            messageHeadline: row.commit.message.split("\n")[0] ?? "",
            committedDate: row.commit.committer.date,
            authors: row.author ? [actor(row.author)].filter((value) => value !== null) : [],
            ...(row.stats
              ? { additions: row.stats.additions, deletions: row.stats.deletions }
              : {}),
          }))
          .sort((a, b) => a.committedDate.localeCompare(b.committedDate)),
        reactions: reactions(rawReactions, viewer.login),
      };
    },
  );
  return { getChangeRequestActivity };
});
