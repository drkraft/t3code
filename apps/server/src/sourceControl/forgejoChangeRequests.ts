import { Effect, Option, Schema } from "effect";
import type { ChangeRequest } from "@t3tools/contracts";
import * as Repositories from "./forgejoRepository.ts";
import * as Source from "./SourceControlProvider.ts";
const Branch = Schema.Struct({
  ref: Schema.NonEmptyString,
  sha: Schema.String,
  repo: Schema.NullOr(Repositories.Repository),
});
export const PullRequest = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.NonEmptyString,
  html_url: Schema.NonEmptyString,
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.Boolean,
  draft: Schema.optional(Schema.Boolean),
  updated_at: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  base: Branch,
  head: Branch,
});
export const toChangeRequest = (pr: typeof PullRequest.Type): ChangeRequest => ({
  provider: "forgejo",
  number: pr.number,
  title: pr.title,
  url: pr.html_url,
  baseRefName: pr.base.ref,
  headRefName: pr.head.ref,
  state: pr.merged ? "merged" : pr.state,
  isDraft: pr.draft ?? false,
  updatedAt: Option.fromNullishOr(pr.updated_at),
  closedAt: pr.closed_at ?? null,
  mergedAt: pr.merged_at ?? null,
  isCrossRepository: pr.head.repo?.id !== pr.base.repo?.id,
  headRepositoryNameWithOwner: pr.head.repo?.full_name ?? null,
  headRepositoryOwnerLogin: pr.head.repo?.full_name.split("/")[0] ?? null,
});

export const make = Effect.gen(function* () {
  const repositories = yield* Repositories.make;
  const { api } = repositories;
  const list = Effect.fn("ForgejoChangeRequests.list")(function* (
    input: Parameters<Source.SourceControlProvider["Service"]["listChangeRequests"]>[0],
  ) {
    const repository = yield* repositories.resolve(input);
    const source = Source.sourceControlRefFromInput(input);
    const branch = Source.sourceBranch(input);
    const limit = Math.max(0, input.limit ?? 100);
    const results: Array<typeof PullRequest.Type> = [];
    const state = input.state === "merged" ? "closed" : input.state;
    let path: string | null =
      `${Repositories.repositoryPath(repository)}/pulls?state=${state}&limit=50`;
    const visited = new Set<string>();
    while (path && results.length < limit) {
      if (visited.has(path))
        return yield* Repositories.failure("Forgejo returned a repeated pagination link.");
      visited.add(path);
      const page: {
        readonly items: ReadonlyArray<typeof PullRequest.Type>;
        readonly next: string | null;
      } = yield* api.page({ host: repository.host, path, schema: PullRequest });
      for (const pr of page.items) {
        const owner = pr.head.repo?.full_name.split("/")[0];
        const name = pr.head.repo?.full_name.split("/")[1];
        if (
          pr.head.ref !== branch ||
          (source?.owner && owner !== source.owner) ||
          (source?.repository && name !== source.repository)
        )
          continue;
        if (input.state !== "all" && toChangeRequest(pr).state !== input.state) continue;
        results.push(pr);
        if (results.length === limit) break;
      }
      path = page.next;
    }
    return results;
  });
  const get = Effect.fn("ForgejoChangeRequests.get")(function* (
    input: Parameters<Source.SourceControlProvider["Service"]["getChangeRequest"]>[0],
  ) {
    let repository = yield* repositories.resolve(input);
    let reference = input.reference.trim();
    if (reference.includes("://")) {
      const url = URL.parse(reference);
      const match =
        url && !url.username && !url.password && !url.search && !url.hash
          ? /^(.*)\/pulls\/(\d+)\/?$/u.exec(url.pathname)
          : null;
      const ref = url && match?.[1] ? repositories.parse(`${url.origin}${match[1]}`) : null;
      if (
        !ref ||
        !match?.[2] ||
        ref.host !== repository.host ||
        ref.owner !== repository.owner ||
        ref.name !== repository.name
      )
        return yield* Repositories.failure(
          "The pull request URL does not match the selected repository.",
        );
      repository = ref;
      reference = match[2];
    }
    if (/^#?\d+$/u.test(reference))
      return yield* api.request({
        host: repository.host,
        path: `${Repositories.repositoryPath(repository)}/pulls/${reference.replace(/^#/u, "")}`,
        schema: PullRequest,
      });
    const matches = yield* list({ ...input, headSelector: reference, state: "open", limit: 2 });
    if (matches.length !== 1 || !matches[0])
      return yield* Repositories.failure("The branch must identify exactly one open pull request.");
    return matches[0];
  });
  return { repositories, list, get };
});
