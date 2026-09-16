import { Schema } from "effect";
import type { PullRequestReaction, PullRequestReactionContent } from "@t3tools/contracts";
import { Actor } from "./forgejoPullRequestJson.ts";

export const Comment = Schema.Struct({
  id: Schema.Int,
  body: Schema.String,
  user: Schema.NullOr(Actor),
  created_at: Schema.String,
  html_url: Schema.String,
});
export const Review = Schema.Struct({
  id: Schema.Int,
  body: Schema.String,
  user: Schema.NullOr(Actor),
  submitted_at: Schema.String,
  html_url: Schema.String,
  state: Schema.String,
  dismissed: Schema.Boolean,
  comments_count: Schema.Int,
});
export const ReviewComment = Schema.Struct({
  ...Comment.fields,
  pull_request_review_id: Schema.Int,
  path: Schema.NonEmptyString,
  position: Schema.Int,
  original_position: Schema.Int,
  commit_id: Schema.NonEmptyString,
  resolver: Schema.NullOr(Actor),
});
export const Reaction = Schema.Struct({ content: Schema.String, user: Schema.NullOr(Actor) });
export const Commit = Schema.Struct({
  sha: Schema.NonEmptyString,
  author: Schema.NullOr(Actor),
  commit: Schema.Struct({
    message: Schema.String,
    committer: Schema.Struct({ date: Schema.String }),
  }),
  stats: Schema.optional(
    Schema.NullOr(Schema.Struct({ additions: Schema.Int, deletions: Schema.Int })),
  ),
});

const reactionNames: Readonly<Record<string, PullRequestReactionContent>> = {
  "+1": "thumbs-up",
  "-1": "thumbs-down",
  laugh: "laugh",
  hooray: "hooray",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};
export function reactions(
  rows: readonly (typeof Reaction.Type)[],
  viewer: string,
): PullRequestReaction[] {
  const grouped = new Map<PullRequestReactionContent, Map<number, string | null>>();
  let anonymousId = 0;
  for (const row of rows) {
    const content = reactionNames[row.content];
    if (!content) continue;
    const users = grouped.get(content) ?? new Map<number, string | null>();
    users.set(row.user?.id ?? --anonymousId, row.user?.login ?? null);
    grouped.set(content, users);
  }
  return [...grouped].map(([content, users]) => ({
    content,
    count: users.size,
    actors: [...users.values()].flatMap((login) =>
      login !== null && login !== viewer ? [login] : [],
    ),
    viewerHasReacted: [...users.values()].includes(viewer),
  }));
}

const encodeIdentity = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      host: Schema.String,
      repository: Schema.String,
      number: Schema.Int,
      review: Schema.Int,
      path: Schema.String,
      line: Schema.Int,
      commit: Schema.String,
    }),
  ),
);

export function threadIdentity(
  input: { readonly host: string; readonly repository: string; readonly number: number },
  comment: Pick<
    typeof ReviewComment.Type,
    "pull_request_review_id" | "path" | "position" | "original_position" | "commit_id"
  >,
): string {
  return `forgejo:${encodeURIComponent(
    encodeIdentity({
      host: input.host,
      repository: input.repository,
      number: input.number,
      review: comment.pull_request_review_id,
      path: comment.path,
      line: comment.position || -comment.original_position,
      commit: comment.commit_id,
    }),
  )}`;
}
