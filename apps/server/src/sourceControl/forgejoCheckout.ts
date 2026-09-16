import { Effect, Schema } from "effect";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Pulls from "./forgejoChangeRequests.ts";
import * as Repositories from "./forgejoRepository.ts";
import type * as Source from "./SourceControlProvider.ts";

const Branch = Schema.Struct({ name: Schema.NonEmptyString });

export const make = Effect.fn("ForgejoCheckout.make")(function* (
  pulls: Effect.Success<typeof Pulls.make>,
) {
  const git = yield* Git.GitVcsDriver;
  const { repositories } = pulls;
  const { api } = repositories;
  return Effect.fn("ForgejoCheckout.checkout")(function* (
    input: Parameters<Source.SourceControlProvider["Service"]["checkoutChangeRequest"]>[0],
  ) {
    const status = yield* git.statusDetailsLocal(input.cwd);
    if (status.hasWorkingTreeChanges)
      return yield* Repositories.failure(
        "Commit or stash local changes before checking out a pull request.",
      );
    const ref = yield* repositories.resolve(input);
    const pr = yield* pulls.get(input);
    const base = yield* repositories.get(ref);
    if (!repositories.validateCloneUrls(base, ref.host))
      return yield* Repositories.failure("The repository clone URLs are not trusted.");
    const remoteName =
      input.context?.remoteName ??
      (yield* git.ensureRemote({ cwd: input.cwd, preferredName: "forgejo", url: base.clone_url }));
    const localBranch = pr.head.repo?.id === pr.base.repo?.id ? pr.head.ref : `pr-${pr.number}`;
    let sourceRemote: string | undefined;
    if (pr.head.repo) {
      if (!repositories.validateCloneUrls(pr.head.repo, ref.host))
        return yield* Repositories.failure("The source repository clone URLs are not trusted.");
      const source = repositories.parse(pr.head.repo.clone_url);
      if (!source) return yield* Repositories.failure("The source repository is invalid.");
      const branch = yield* api
        .request({
          host: ref.host,
          path: `${Repositories.repositoryPath(source)}/branches/${encodeURIComponent(pr.head.ref)}`,
          schema: Branch,
        })
        .pipe(
          Effect.catchTag("ForgejoApiError", (error) =>
            error.reason === "not-found" ? Effect.succeed(null) : Effect.fail(error),
          ),
        );
      if (branch) {
        sourceRemote =
          pr.head.repo.id === base.id
            ? remoteName
            : yield* git.ensureRemote({
                cwd: input.cwd,
                preferredName: `forgejo-${source.owner}`,
                url:
                  input.context?.remoteUrl.startsWith("https://") ||
                  input.context?.remoteUrl.startsWith("http://")
                    ? pr.head.repo.clone_url
                    : pr.head.repo.ssh_url,
              });
        yield* git.fetchRemoteTrackingBranch({
          cwd: input.cwd,
          remoteName: sourceRemote,
          remoteBranch: pr.head.ref,
        });
      }
    }
    yield* git.execute({
      cwd: input.cwd,
      operation: "Forgejo.checkout.fetch",
      args: ["fetch", "--quiet", "--no-tags", "--", remoteName, `refs/pull/${pr.number}/head`],
    });
    const fetched = yield* git.execute({
      cwd: input.cwd,
      operation: "Forgejo.checkout.verifyHead",
      args: ["rev-parse", "FETCH_HEAD"],
    });
    if (fetched.stdout.trim() !== pr.head.sha)
      return yield* Repositories.failure(
        "The pull request head changed during checkout. Refresh and retry.",
      );
    const names = yield* git.listLocalBranchNames(input.cwd);
    if (names.includes(localBranch) && input.force !== true) {
      const localHead = yield* git.execute({
        cwd: input.cwd,
        operation: "Forgejo.checkout.localHead",
        args: ["rev-parse", `refs/heads/${localBranch}`],
      });
      if (localHead.stdout.trim() !== pr.head.sha)
        return yield* Repositories.failure(
          "The local branch differs from the pull request head. Preserve your commits or explicitly force checkout.",
        );
    }
    if (!names.includes(localBranch) || input.force === true) {
      yield* git.execute({
        cwd: input.cwd,
        operation: "Forgejo.checkout.branch",
        args:
          status.branch === localBranch
            ? ["reset", "--keep", "FETCH_HEAD"]
            : ["branch", ...(input.force ? ["--force"] : []), "--", localBranch, "FETCH_HEAD"],
      });
    }
    if (sourceRemote)
      yield* git.setBranchUpstream({
        cwd: input.cwd,
        branch: localBranch,
        remoteName: sourceRemote,
        remoteBranch: pr.head.ref,
      });
    else {
      const configuredRemote = yield* git.readConfigValue(
        input.cwd,
        `branch.${localBranch}.remote`,
      );
      if (configuredRemote)
        yield* git.execute({
          cwd: input.cwd,
          operation: "Forgejo.checkout.clearUpstream",
          args: ["branch", "--unset-upstream", "--", localBranch],
        });
    }
    yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
  });
});
