import { Effect, Schema } from "effect";
import type { ProviderChangeRequest } from "./PullRequestProvider.ts";
import type { PullRequestActor } from "@t3tools/contracts";
import { ForgejoApiError } from "../sourceControl/ForgejoApi.ts";

export const Actor = Schema.Struct({
  id: Schema.Int,
  login: Schema.NonEmptyString,
  full_name: Schema.optional(Schema.String),
  avatar_url: Schema.optional(Schema.String),
});
export const actor = (value: typeof Actor.Type | null): PullRequestActor | null =>
  value
    ? {
        login: value.login,
        name: value.full_name || null,
        avatarUrl: value.avatar_url || null,
      }
    : null;
const Branch = Schema.Struct({
  ref: Schema.String,
  sha: Schema.String,
  repo: Schema.NullOr(Schema.Struct({ full_name: Schema.NonEmptyString })),
});
export const PullRequest = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  html_url: Schema.String,
  user: Schema.NullOr(Actor),
  body: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.Boolean,
  draft: Schema.Boolean,
  allow_maintainer_edit: Schema.optional(Schema.Boolean),
  flow: Schema.optional(Schema.Int),
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  merge_base: Schema.String,
  head: Branch,
  base: Branch,
  additions: Schema.Int,
  deletions: Schema.Int,
  changed_files: Schema.Int,
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.NullOr(Schema.String),
  merged_at: Schema.NullOr(Schema.String),
  requested_reviewers: Schema.NullOr(Schema.Array(Actor)),
  requested_reviewers_teams: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          id: Schema.Int,
          name: Schema.NonEmptyString,
        }),
      ),
    ),
  ),
  labels: Schema.NullOr(
    Schema.Array(Schema.Struct({ name: Schema.NonEmptyString, color: Schema.String })),
  ),
});
export const toChangeRequest = (pr: typeof PullRequest.Type): ProviderChangeRequest => ({
  number: pr.number,
  title: pr.title,
  url: pr.html_url,
  author: actor(pr.user),
  headBranch: pr.head.ref,
  headRepositoryNameWithOwner: pr.head.repo?.full_name ?? null,
  baseBranch: pr.base.ref,
  state: pr.merged ? "merged" : pr.state,
  isDraft: pr.draft,
  // Forgejo also reports false while checking, after check errors, and for WIP titles.
  mergeability: pr.mergeable === true ? "mergeable" : "unknown",
  additions: pr.additions,
  deletions: pr.deletions,
  createdAt: pr.created_at,
  updatedAt: pr.updated_at,
  closedAt: pr.closed_at,
  mergedAt: pr.merged_at,
  reviewRequestLogins: (pr.requested_reviewers ?? []).map((user) => user.login),
  labels: (pr.labels ?? []).map((label) => ({ name: label.name, color: label.color || null })),
});
const Slug = Schema.String.check(Schema.isPattern(/^[^/\\:?#\s]+\/[^/\\:?#\s]+$/u));
const decodeSlug = Schema.decodeUnknownEffect(Slug);
export const repositoryPath = (input: { readonly repository: string }) =>
  decodeSlug(input.repository).pipe(
    Effect.filterOrFail(
      (slug) => slug.split("/").every((part) => part !== "." && part !== ".."),
      () =>
        new ForgejoApiError({ reason: "invalid-url", detail: "Use an owner/repository identity." }),
    ),
    Effect.map((slug) => `/repos/${slug.split("/").map(encodeURIComponent).join("/")}`),
    Effect.mapError(
      () =>
        new ForgejoApiError({ reason: "invalid-url", detail: "Use an owner/repository identity." }),
    ),
  );
