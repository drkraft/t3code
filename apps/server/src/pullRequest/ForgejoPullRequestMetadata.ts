import { Effect, Schema } from "effect";
import type { PullRequestProviderApi } from "./PullRequestProvider.ts";
import { ForgejoApi, ForgejoApiError } from "../sourceControl/ForgejoApi.ts";
import { Actor, repositoryPath } from "./forgejoPullRequestJson.ts";

const encodeReviewers = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      reviewers: Schema.Array(Schema.String),
      team_reviewers: Schema.Array(Schema.String),
    }),
  ),
);
const encodeLabels = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ labels: Schema.Array(Schema.String) })),
);
const encodeReaction = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ content: Schema.String })),
);
const Team = Schema.Struct({ id: Schema.Int, name: Schema.NonEmptyString });
const Label = Schema.Struct({
  id: Schema.Int,
  name: Schema.NonEmptyString,
  color: Schema.String,
  description: Schema.optional(Schema.String),
});
const ReviewRequest = Schema.Struct({
  state: Schema.String,
  user: Schema.NullOr(Actor),
  team: Schema.NullOr(Team),
});
const Reviewers = Schema.Struct({
  user: Schema.NullOr(Actor),
});
type Input<K extends keyof PullRequestProviderApi> = Parameters<
  Extract<PullRequestProviderApi[K], (...args: never[]) => unknown>
>[0];
export const make = Effect.gen(function* () {
  const api = yield* ForgejoApi;
  const allPages = <S extends Schema.Top>(input: {
    readonly host: string;
    readonly path: string;
    readonly schema: S;
  }) =>
    Effect.gen(function* () {
      const rows: S["Type"][] = [];
      let path: string | null = input.path;
      const seen = new Set<string>();
      while (path) {
        if (seen.has(path) || seen.size >= 100)
          return yield* new ForgejoApiError({
            reason: "invalid-response",
            detail: "Forgejo metadata pagination did not complete.",
          });
        seen.add(path);
        const page: { readonly items: readonly S["Type"][]; readonly next: string | null } =
          yield* api.page({ ...input, path, allowNullItems: true });
        rows.push(...page.items);
        path = page.next;
      }
      return rows;
    });
  const listRequestedReviewers = Effect.fn("ForgejoPullRequestMetadata.listRequestedReviewers")(
    function* (input: Input<"listReviewerCandidates">) {
      const root = yield* repositoryPath(input);
      const reviews = yield* allPages({
        host: input.host,
        path: `${root}/pulls/${input.number}/reviews?limit=50`,
        schema: ReviewRequest,
      });
      const requested = reviews.filter((review) => review.state === "REQUEST_REVIEW");
      return {
        users: requested.flatMap((review) => (review.user ? [review.user] : [])),
        teams: requested.flatMap((review) => (review.team ? [review.team] : [])),
      };
    },
  );
  const listReviewerCandidates = Effect.fn("ForgejoPullRequestMetadata.listReviewerCandidates")(
    function* (input: Input<"listReviewerCandidates">) {
      const root = yield* repositoryPath(input);
      const pr = yield* api.request({
        host: input.host,
        path: `${root}/pulls/${input.number}`,
        schema: Reviewers,
      });
      const requested = yield* listRequestedReviewers(input);
      const users = yield* allPages({ host: input.host, path: `${root}/reviewers`, schema: Actor });
      const teams = yield* allPages({ host: input.host, path: `${root}/teams`, schema: Team }).pipe(
        Effect.catchIf(
          (error) => error.status === 405,
          () => Effect.succeed([]),
        ),
      );
      return {
        truncated: false,
        candidates: [
          ...users
            .filter((row) => row.id !== pr.user?.id)
            .map((row) => ({
              id: row.login,
              kind: "user" as const,
              login: row.login,
              name: row.full_name || null,
              avatarUrl: row.avatar_url || null,
              isRequested: requested.users.some((requested) => requested.id === row.id),
            })),
          ...teams.map((row) => ({
            id: row.name,
            kind: "team" as const,
            login: row.name,
            name: row.name,
            avatarUrl: null,
            isRequested: requested.teams.some((requested) => requested.id === row.id),
          })),
        ],
      };
    },
  );
  const setReviewerRequest = Effect.fn("ForgejoPullRequestMetadata.setReviewerRequest")(function* (
    input: Input<"setReviewerRequest">,
  ) {
    const root = yield* repositoryPath(input);
    yield* api.request({
      host: input.host,
      path: `${root}/pulls/${input.number}/requested_reviewers`,
      method: input.requested ? "POST" : "DELETE",
      schema: input.requested ? Schema.Unknown : Schema.Void,
      body: encodeReviewers({
        reviewers: input.reviewers.filter((row) => row.kind === "user").map((row) => row.id),
        team_reviewers: input.reviewers.filter((row) => row.kind === "team").map((row) => row.id),
      }),
    });
  });
  const listLabelCandidates = Effect.fn("ForgejoPullRequestMetadata.listLabelCandidates")(
    function* (input: Input<"listLabelCandidates">) {
      const root = yield* repositoryPath(input);
      const labels = yield* allPages({
        host: input.host,
        path: `${root}/labels?limit=50`,
        schema: Label,
      });
      const orgLabels = yield* allPages({
        host: input.host,
        path: `/orgs/${root.split("/")[2]}/labels?limit=50`,
        schema: Label,
      }).pipe(
        Effect.catchIf(
          (error) => error.status === 404,
          () => Effect.succeed([]),
        ),
      );
      const applied = yield* allPages({
        host: input.host,
        path: `${root}/issues/${input.number}/labels`,
        schema: Label,
      });
      const appliedIds = new Set(applied.map((label) => label.id));
      const appliedNames = new Set(
        [...labels, ...orgLabels]
          .filter((label) => appliedIds.has(label.id))
          .map((label) => label.name),
      );
      return {
        truncated: false,
        candidates: [
          ...new Map([...labels, ...orgLabels].map((label) => [label.name, label])).values(),
        ].map((label) => ({
          name: label.name,
          color: label.color || null,
          description: label.description || null,
          isApplied: appliedNames.has(label.name),
        })),
      };
    },
  );
  const setLabels = Effect.fn("ForgejoPullRequestMetadata.setLabels")(function* (
    input: Input<"setLabels">,
  ) {
    const root = yield* repositoryPath(input);
    const path = `${root}/issues/${input.number}/labels`;
    if (input.applied) {
      yield* api.request({
        host: input.host,
        path,
        method: "POST",
        body: encodeLabels({ labels: input.labels }),
        schema: Schema.Unknown,
      });
    } else {
      const applied = yield* allPages({ host: input.host, path, schema: Label });
      for (const label of applied.filter((row) => input.labels.includes(row.name))) {
        yield* api.request({
          host: input.host,
          path: `${path}/${label.id}`,
          method: "DELETE",
          schema: Schema.Void,
        });
      }
    }
  });
  const setReaction = Effect.fn("ForgejoPullRequestMetadata.setReaction")(function* (
    input: Input<"setReaction">,
  ) {
    if (input.subjectId !== undefined && !/^[1-9]\d*$/u.test(input.subjectId))
      return yield* new ForgejoApiError({
        reason: "invalid-response",
        detail: "The reaction subject is not a Forgejo comment identity.",
      });
    const root = yield* repositoryPath(input);
    const path =
      input.subjectId === undefined
        ? `${root}/issues/${input.number}/reactions`
        : `${root}/issues/comments/${input.subjectId}/reactions`;
    const names = {
      "thumbs-up": "+1",
      "thumbs-down": "-1",
      laugh: "laugh",
      hooray: "hooray",
      confused: "confused",
      heart: "heart",
      rocket: "rocket",
      eyes: "eyes",
    } as const;
    yield* api.request({
      host: input.host,
      path,
      method: input.reacted ? "POST" : "DELETE",
      body: encodeReaction({ content: names[input.content] }),
      schema: input.reacted ? Schema.Unknown : Schema.Void,
    });
  });
  return {
    listRequestedReviewers,
    listReviewerCandidates,
    setReviewerRequest,
    listLabelCandidates,
    setLabels,
    setReaction,
  };
});
