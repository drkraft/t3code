import { Effect, FileSystem, Schema } from "effect";
import { SourceControlProviderError } from "@t3tools/contracts";
import * as Source from "./SourceControlProvider.ts";
import * as Pulls from "./forgejoChangeRequests.ts";
import * as Repositories from "./forgejoRepository.ts";
import * as Checkout from "./forgejoCheckout.ts";
import { ForgejoApiError } from "./ForgejoApi.ts";

const isForgejoApiError = Schema.is(ForgejoApiError);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const make = Effect.gen(function* () {
  const pulls = yield* Pulls.make;
  const { repositories } = pulls;
  const { api } = repositories;
  const fs = yield* FileSystem.FileSystem;
  const checkout = yield* Checkout.make(pulls);
  const wrap = <A, E>(operation: string, cwd: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError(
        (error) =>
          new SourceControlProviderError({
            provider: "forgejo",
            operation,
            cwd,
            detail: isForgejoApiError(error)
              ? error.detail
              : `Forgejo ${operation} failed. Check the selected repository, permissions and local Git state.`,
          }),
      ),
    );
  return Source.SourceControlProvider.of({
    kind: "forgejo",
    listChangeRequests: (input) =>
      wrap(
        "listChangeRequests",
        input.cwd,
        pulls.list(input).pipe(Effect.map((items) => items.map(Pulls.toChangeRequest))),
      ),
    getChangeRequest: (input) =>
      wrap("getChangeRequest", input.cwd, pulls.get(input).pipe(Effect.map(Pulls.toChangeRequest))),
    getRepositoryCloneUrls: (input) =>
      wrap(
        "getRepositoryCloneUrls",
        input.cwd,
        Effect.gen(function* () {
          const ref = yield* repositories.resolve(input);
          const repo = yield* repositories.get(ref);
          if (!repositories.validateCloneUrls(repo, ref.host))
            return yield* Repositories.failure(
              "The repository clone URLs do not match its configured Forgejo connection.",
            );
          return Repositories.cloneUrls(repo);
        }),
      ),
    getDefaultBranch: (input) =>
      wrap(
        "getDefaultBranch",
        input.cwd,
        Effect.gen(function* () {
          const ref = yield* repositories.resolve(input);
          const repo = yield* repositories.get(ref);
          return repo.empty || !repo.default_branch ? null : repo.default_branch;
        }),
      ),
    createRepository: (input) =>
      wrap(
        "createRepository",
        input.cwd,
        Effect.gen(function* () {
          const ref = yield* repositories.resolve(input);
          const viewer = yield* api.getViewer(ref.host);
          const path =
            viewer.login.toLowerCase() === ref.owner.toLowerCase()
              ? "/user/repos"
              : `/orgs/${encodeURIComponent(ref.owner)}/repos`;
          const repo = yield* api.request({
            host: ref.host,
            path,
            method: "POST",
            body: encode({
              name: ref.name,
              private: input.visibility === "private",
              auto_init: false,
            }),
            schema: Repositories.Repository,
          });
          if (!repositories.validateCloneUrls(repo, ref.host))
            return yield* Repositories.failure(
              "The created repository returned untrusted clone URLs.",
            );
          return Repositories.cloneUrls(repo);
        }),
      ),
    createChangeRequest: (input) =>
      wrap(
        "createChangeRequest",
        input.cwd,
        Effect.gen(function* () {
          const selected = yield* repositories.resolve(input);
          const target = {
            ...selected,
            owner: input.target?.owner ?? selected.owner,
            name: input.target?.repository ?? selected.name,
          };
          const targetRepo = yield* repositories.get(target);
          if (targetRepo.empty)
            return yield* Repositories.failure(
              "A pull request requires a target repository with commits.",
            );
          const source = Source.sourceControlRefFromInput(input);
          const sourceOwner = source?.owner ?? selected.owner;
          const sourceName = source?.repository ?? selected.name;
          if (sourceOwner === target.owner && sourceName !== target.name)
            return yield* Repositories.failure(
              "Forgejo cannot select a different source repository belonging to the target owner.",
            );
          if (sourceOwner !== target.owner && source?.repository !== undefined) {
            const sourceRepo = yield* repositories.get({
              ...target,
              owner: sourceOwner,
              name: sourceName,
            });
            if (sourceRepo.parent?.id !== targetRepo.id && targetRepo.parent?.id !== sourceRepo.id)
              return yield* Repositories.failure(
                "The selected source repository must be the target's fork or parent.",
              );
          }
          const body = yield* fs.readFileString(input.bodyFile);
          yield* api.request({
            host: target.host,
            path: `${Repositories.repositoryPath(target)}/pulls`,
            method: "POST",
            body: encode({
              title: input.title,
              body,
              base: input.target?.refName ?? input.baseRefName,
              head:
                sourceOwner === target.owner
                  ? Source.sourceBranch(input)
                  : `${sourceOwner}:${Source.sourceBranch(input)}`,
            }),
            schema: Pulls.PullRequest,
          });
        }),
      ),
    checkoutChangeRequest: (input) => wrap("checkoutChangeRequest", input.cwd, checkout(input)),
  });
});
