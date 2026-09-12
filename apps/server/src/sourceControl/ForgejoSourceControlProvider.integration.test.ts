import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result } from "effect";
import * as ServerConfig from "../config.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsRegistry from "../vcs/VcsDriverRegistry.ts";
import * as Provider from "./ForgejoSourceControlProvider.ts";
import { apiHarness, context, pullRequest, repository } from "./forgejoSourceControlTestUtils.ts";

const gitLayer = Git.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-forgejo-checkout-config-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.mock(VcsRegistry.VcsDriverRegistry)({ detect: () => Effect.succeed(null) }),
  ),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const driver = yield* Git.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-forgejo-checkout-" });
  const origin = `${root}/origin`;
  const cwd = `${root}/work`;
  yield* fs.makeDirectory(origin);
  const run = Effect.fn("ForgejoCheckoutTest.git")(function* (
    directory: string,
    args: readonly string[],
  ) {
    const result = yield* driver.execute({
      cwd: directory,
      args,
      operation: "test",
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
  yield* run(origin, ["init", "--initial-branch=develop"]);
  yield* run(origin, ["config", "user.email", "test@example.invalid"]);
  yield* run(origin, ["config", "user.name", "Test"]);
  yield* fs.writeFileString(`${origin}/file.txt`, "base\n");
  yield* run(origin, ["add", "."]);
  yield* run(origin, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  yield* run(origin, ["switch", "-c", "feature"]);
  yield* fs.writeFileString(`${origin}/file.txt`, "pull request\n");
  yield* run(origin, ["add", "."]);
  yield* run(origin, ["-c", "commit.gpgsign=false", "commit", "-m", "feature"]);
  const head = yield* run(origin, ["rev-parse", "HEAD"]);
  yield* run(origin, ["update-ref", "refs/pull/42/head", head]);
  yield* run(origin, ["switch", "develop"]);
  yield* run(root, ["clone", "--quiet", origin, cwd]);
  yield* run(cwd, ["config", "user.email", "test@example.invalid"]);
  yield* run(cwd, ["config", "user.name", "Test"]);
  yield* run(cwd, ["config", `url.${origin}.insteadOf`, pullRequest.head.repo.ssh_url]);
  const git = (args: readonly string[]) => run(cwd, args);
  const api = (deleted: boolean | "branch", sameRepo = false) =>
    apiHarness((request) =>
      deleted === "branch" && request.url.endsWith("/branches/feature")
        ? new Response(null, { status: 404 })
        : Response.json(
            request.url.endsWith("/pulls/42")
              ? {
                  ...pullRequest,
                  head: {
                    ...pullRequest.head,
                    sha: head,
                    repo: deleted === true ? null : sameRepo ? repository : pullRequest.head.repo,
                  },
                }
              : request.url.endsWith("/branches/feature")
                ? { name: "feature" }
                : repository,
          ),
    ).layer;
  return { fs, cwd, head, git, api };
});

it.effect("rejects a stale same-repository source branch without moving any local branch", () =>
  Effect.gen(function* () {
    const { fs, cwd, git, api } = yield* fixture;
    yield* git(["branch", "feature", "develop"]);
    const previousHead = yield* git(["rev-parse", "HEAD"]);
    const provider = yield* Provider.make.pipe(Effect.provide(api(false, true)));
    const result = yield* provider
      .checkoutChangeRequest({ cwd, context, reference: "42" })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    assert.strictEqual(yield* git(["branch", "--show-current"]), "develop");
    assert.strictEqual(yield* git(["rev-parse", "HEAD"]), previousHead);
    assert.strictEqual(yield* git(["rev-parse", "refs/heads/feature"]), previousHead);
    assert.strictEqual(yield* fs.readFileString(`${cwd}/file.txt`), "base\n");
  }).pipe(Effect.scoped, Effect.provide(gitLayer)),
);

for (const deleted of [false, true, "branch"] as const) {
  it.effect(`checks out the exact fork head through the base PR ref when deleted=${deleted}`, () =>
    Effect.gen(function* () {
      const { fs, cwd, head, git, api } = yield* fixture;
      const provider = yield* Provider.make.pipe(Effect.provide(api(deleted)));
      yield* provider.checkoutChangeRequest({ cwd, context, reference: "42" });
      assert.strictEqual(yield* git(["branch", "--show-current"]), "pr-42");
      assert.strictEqual(yield* git(["rev-parse", "HEAD"]), head);
      assert.strictEqual(yield* fs.readFileString(`${cwd}/file.txt`), "pull request\n");
      assert.strictEqual(
        yield* git(["for-each-ref", "--format=%(upstream:short)", "refs/heads/pr-42"]),
        deleted ? "" : "forgejo-alice/feature",
      );
      if (!deleted) {
        assert.strictEqual(
          yield* git(["config", "--get", "remote.forgejo-alice.url"]),
          pullRequest.head.repo.ssh_url,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(gitLayer)),
  );
}

it.effect("rejects a dirty checkout while preserving the branch and file contents", () =>
  Effect.gen(function* () {
    const { fs, cwd, git, api } = yield* fixture;
    yield* fs.writeFileString(`${cwd}/file.txt`, "local edits\n");
    const provider = yield* Provider.make.pipe(Effect.provide(api(false)));
    const result = yield* provider
      .checkoutChangeRequest({ cwd, context, reference: "42" })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    assert.strictEqual(yield* git(["branch", "--show-current"]), "develop");
    assert.strictEqual(yield* fs.readFileString(`${cwd}/file.txt`), "local edits\n");
  }).pipe(Effect.scoped, Effect.provide(gitLayer)),
);

it.effect("clears the old upstream when reusing an exact PR branch after source deletion", () =>
  Effect.gen(function* () {
    const { cwd, head, git, api } = yield* fixture;
    yield* git(["branch", "--track", "pr-42", "origin/feature"]);
    const provider = yield* Provider.make.pipe(Effect.provide(api(true)));
    yield* provider.checkoutChangeRequest({ cwd, context, reference: "42" });
    assert.strictEqual(yield* git(["branch", "--show-current"]), "pr-42");
    assert.strictEqual(yield* git(["rev-parse", "HEAD"]), head);
    assert.strictEqual(
      yield* git(["for-each-ref", "--format=%(upstream:short)", "refs/heads/pr-42"]),
      "",
    );
  }).pipe(Effect.scoped, Effect.provide(gitLayer)),
);

for (const force of [false, true]) {
  it.effect(`preserves existing PR branch commits unless force=${force}`, () =>
    Effect.gen(function* () {
      const { fs, cwd, head, git, api } = yield* fixture;
      yield* git(["switch", "-c", "pr-42"]);
      yield* fs.writeFileString(`${cwd}/file.txt`, "local commit\n");
      yield* git(["add", "."]);
      yield* git(["-c", "commit.gpgsign=false", "commit", "-m", "local"]);
      const localHead = yield* git(["rev-parse", "HEAD"]);
      yield* git(["switch", "develop"]);
      const previousHead = yield* git(["rev-parse", "HEAD"]);
      const provider = yield* Provider.make.pipe(Effect.provide(api(false)));
      const result = yield* provider
        .checkoutChangeRequest({ cwd, context, reference: "42", force })
        .pipe(Effect.result);
      assert.strictEqual(Result.isSuccess(result), force);
      assert.strictEqual(yield* git(["branch", "--show-current"]), force ? "pr-42" : "develop");
      assert.strictEqual(yield* git(["rev-parse", "HEAD"]), force ? head : previousHead);
      assert.strictEqual(yield* git(["rev-parse", "refs/heads/pr-42"]), force ? head : localHead);
      assert.strictEqual(
        yield* fs.readFileString(`${cwd}/file.txt`),
        force ? "pull request\n" : "base\n",
      );
    }).pipe(Effect.scoped, Effect.provide(gitLayer)),
  );
}

it.effect("reuses an existing local PR branch when it matches the exact remote head", () =>
  Effect.gen(function* () {
    const { fs, cwd, head, git, api } = yield* fixture;
    yield* git(["branch", "pr-42", head]);
    const provider = yield* Provider.make.pipe(Effect.provide(api(false)));
    yield* provider.checkoutChangeRequest({ cwd, context, reference: "42" });
    assert.strictEqual(yield* git(["branch", "--show-current"]), "pr-42");
    assert.strictEqual(yield* git(["rev-parse", "HEAD"]), head);
    assert.strictEqual(yield* fs.readFileString(`${cwd}/file.txt`), "pull request\n");
  }).pipe(Effect.scoped, Effect.provide(gitLayer)),
);

it.effect("refreshes an already checked out PR branch when force is explicit", () =>
  Effect.gen(function* () {
    const { fs, cwd, head, git, api } = yield* fixture;
    yield* git(["switch", "-c", "pr-42"]);
    yield* fs.writeFileString(`${cwd}/file.txt`, "local commit\n");
    yield* git(["add", "."]);
    yield* git(["-c", "commit.gpgsign=false", "commit", "-m", "local"]);
    const provider = yield* Provider.make.pipe(Effect.provide(api(false)));
    yield* provider.checkoutChangeRequest({ cwd, context, reference: "42", force: true });
    assert.strictEqual(yield* git(["branch", "--show-current"]), "pr-42");
    assert.strictEqual(yield* git(["rev-parse", "HEAD"]), head);
    assert.strictEqual(yield* fs.readFileString(`${cwd}/file.txt`), "pull request\n");
  }).pipe(Effect.scoped, Effect.provide(gitLayer)),
);
