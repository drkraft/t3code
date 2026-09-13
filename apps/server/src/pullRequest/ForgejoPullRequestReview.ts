import { Effect, Schema } from "effect";
import type { PullRequestProviderApi, ProviderRepositoryRef } from "./PullRequestProvider.ts";
import { ForgejoApi, ForgejoApiError } from "../sourceControl/ForgejoApi.ts";
import { repositoryPath } from "./forgejoPullRequestJson.ts";
import { ReviewComment, threadIdentity } from "./forgejoActivityJson.ts";

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu));
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.Struct({ baseSha: Sha, headSha: Sha }));
const PullRevisions = Schema.Struct({ head: Schema.Struct({ sha: Sha }), merge_base: Sha });
const Reviewer = Schema.NullOr(Schema.Struct({ id: Schema.Int }));
const Review = Schema.Struct({ id: Schema.Int, state: Schema.String, user: Reviewer });
const Identity = Schema.fromJsonString(
  Schema.Struct({
    host: Schema.String,
    repository: Schema.String,
    number: Schema.Int,
    review: Schema.Int,
    path: Schema.NonEmptyString,
    line: Schema.Int,
    commit: Schema.String,
  }),
);
const encodeBody = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeIdentity = Schema.decodeEffect(Identity);
const invalid = (detail: string) => new ForgejoApiError({ reason: "invalid-response", detail });
const position = (line: number) => ({
  old_position: line < 0 ? -line : 0,
  new_position: line > 0 ? line : 0,
});
type Input<K extends keyof PullRequestProviderApi> = Parameters<
  Extract<PullRequestProviderApi[K], (...args: never[]) => unknown>
>[0];

export const make = Effect.gen(function* () {
  const api = yield* ForgejoApi;
  const reviews = Effect.fn("ForgejoPullRequestReview.reviews")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    const root = yield* repositoryPath(input);
    const result: Array<typeof Review.Type> = [];
    const seen = new Set<string>();
    let path: string | null = `${root}/pulls/${input.number}/reviews?limit=50`;
    while (path !== null) {
      if (seen.has(path) || seen.size >= 100)
        return yield* invalid("Forgejo review pagination did not complete.");
      seen.add(path);
      const page: {
        readonly items: ReadonlyArray<typeof Review.Type>;
        readonly next: string | null;
      } = yield* api.page({ host: input.host, path, schema: Review });
      result.push(...page.items);
      path = page.next;
    }
    return result;
  });
  const write = Effect.fn("ForgejoPullRequestReview.write")(function* (
    input: ProviderRepositoryRef,
    path: string,
    body: object,
    method: "POST" | "PATCH" = "POST",
  ) {
    yield* api.request({
      host: input.host,
      path,
      method,
      body: yield* encodeBody(body).pipe(
        Effect.mapError(() => invalid("Invalid Forgejo request body.")),
      ),
      schema: Schema.Unknown,
    });
  });
  const comment = Effect.fn("ForgejoPullRequestReview.comment")(function* (
    input: Input<"comment">,
  ) {
    const root = yield* repositoryPath(input);
    yield* write(input, `${root}/issues/${input.number}/comments`, { body: input.body });
  });
  const updateChangeRequest = Effect.fn("ForgejoPullRequestReview.updateChangeRequest")(function* (
    input: Input<"updateChangeRequest">,
  ) {
    const root = yield* repositoryPath(input);
    yield* write(
      input,
      `${root}/pulls/${input.number}`,
      {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
      },
      "PATCH",
    );
  });
  const updateComment = Effect.fn("ForgejoPullRequestReview.updateComment")(function* (
    input: Input<"updateComment">,
  ) {
    const root = yield* repositoryPath(input);
    if (!/^[1-9]\d*$/u.test(input.commentId))
      return yield* invalid("Invalid Forgejo comment identity.");
    let found = false;
    if (input.kind === "issue-comment") {
      const pr = yield* api.request({
        host: input.host,
        path: `${root}/pulls/${input.number}`,
        schema: Schema.Struct({ html_url: Schema.String }),
      });
      const row = yield* api.request({
        host: input.host,
        path: `${root}/issues/comments/${input.commentId}`,
        schema: Schema.Struct({ id: Schema.Int, user: Reviewer, pull_request_url: Schema.String }),
      });
      if (String(row.id) !== input.commentId || row.pull_request_url !== pr.html_url)
        return yield* invalid("The comment does not belong to this pull request.");
      found = true;
    } else {
      for (const review of yield* reviews(input)) {
        const rows = yield* api.request({
          host: input.host,
          path: `${root}/pulls/${input.number}/reviews/${review.id}/comments`,
          schema: Schema.NullOr(Schema.Array(ReviewComment)),
        });
        const row = rows?.find(
          (row) => String(row.id) === input.commentId && row.pull_request_review_id === review.id,
        );
        if (row) {
          found = true;
          break;
        }
      }
    }
    if (!found) return yield* invalid("The comment does not belong to this pull request.");
    yield* write(
      input,
      `${root}/issues/comments/${input.commentId}`,
      { body: input.body },
      "PATCH",
    );
  });
  const submitReview = Effect.fn("ForgejoPullRequestReview.submitReview")(function* (
    input: Input<"submitReview">,
  ) {
    const root = yield* repositoryPath(input);
    const snapshot =
      input.comments.length === 0
        ? undefined
        : yield* decodeSnapshot(input.comments[0]?.snapshot).pipe(
            Effect.mapError(() =>
              invalid("Reload the diff and select inline comments with exact revisions."),
            ),
          );
    if (snapshot) {
      for (const draft of input.comments) {
        if (
          draft.snapshot?.baseSha !== snapshot.baseSha ||
          draft.snapshot?.headSha !== snapshot.headSha
        )
          return yield* invalid(
            "Inline comments must share the same diff snapshot. Reload the diff.",
          );
      }
      const current = yield* api.request({
        host: input.host,
        path: `${root}/pulls/${input.number}`,
        schema: PullRevisions,
      });
      if (current.head.sha !== snapshot.headSha || current.merge_base !== snapshot.baseSha)
        return yield* invalid(
          "The pull request changed since these inline comments were selected. Reload the diff.",
        );
    }
    const viewer = yield* api.getViewer(input.host);
    if (
      (yield* reviews(input)).some((row) => row.state === "PENDING" && row.user?.id === viewer.id)
    )
      return yield* invalid(
        "A pending Forgejo review already exists. Inspect and finish or discard it on Forgejo before submitting another review.",
      );
    const comments = input.comments.map((draft) => {
      const p = draft.position;
      const line =
        p.kind === "deleted"
          ? -p.oldLine
          : p.kind === "context" && p.side === "left"
            ? -p.oldLine
            : p.newLine;
      return { path: draft.path, body: draft.body, ...position(line) };
    });
    // Forgejo persists pending comments before submitting the review; this POST is not atomic.
    yield* write(input, `${root}/pulls/${input.number}/reviews`, {
      event: { comment: "COMMENT", approve: "APPROVED", "request-changes": "REQUEST_CHANGES" }[
        input.verdict
      ],
      body: input.body,
      ...(snapshot ? { commit_id: snapshot.headSha } : {}),
      comments,
    }).pipe(
      Effect.mapError(
        (error) =>
          new ForgejoApiError({
            ...error,
            detail: `${error.detail} Inspect the review on Forgejo before retrying; some or all of it may have been saved.`,
          }),
      ),
    );
  });
  const replyToThread = Effect.fn("ForgejoPullRequestReview.replyToThread")(function* (
    input: Input<"replyToThread">,
  ) {
    const root = yield* repositoryPath(input);
    if (!input.threadId.startsWith("forgejo:"))
      return yield* invalid("Invalid Forgejo thread identity.");
    const encoded = yield* Effect.try({
      try: () => decodeURIComponent(input.threadId.slice(8)),
      catch: () => invalid("Invalid Forgejo thread identity."),
    });
    const identity = yield* decodeIdentity(encoded).pipe(
      Effect.mapError(() => invalid("Invalid Forgejo thread identity.")),
    );
    const host = api.resolveConnection(input.host)?.apiUrl ?? input.host;
    if (
      identity.host !== host ||
      identity.repository !== input.repository ||
      identity.number !== input.number ||
      identity.review <= 0 ||
      identity.line === 0
    )
      return yield* invalid("The thread does not belong to this pull request.");
    const path = `${root}/pulls/${input.number}/reviews/${identity.review}/comments`;
    const rows = yield* api.request({
      host: input.host,
      path,
      schema: Schema.NullOr(Schema.Array(ReviewComment)),
    });
    if (!rows?.some((row) => threadIdentity({ ...input, host }, row) === input.threadId))
      return yield* invalid(
        "The original Forgejo thread no longer matches. Refresh before replying.",
      );
    yield* write(input, path, {
      body: input.body,
      path: identity.path,
      ...position(identity.line),
    });
  });
  return { comment, updateChangeRequest, updateComment, submitReview, replyToThread };
});
