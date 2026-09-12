import { Effect, Schema } from "effect";
import { ForgejoApi, ForgejoApiError } from "../sourceControl/ForgejoApi.ts";
import type { PullRequestProviderApi } from "./PullRequestProvider.ts";
import { repositoryPath } from "./forgejoPullRequestJson.ts";

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu));
const decodeSha = Schema.decodeUnknownEffect(Sha);
const Pull = Schema.Struct({ merge_base: Sha });
const Refs = Schema.Array(
  Schema.Struct({ ref: Schema.String, object: Schema.Struct({ sha: Sha }) }),
);
const Commit = Schema.Struct({ sha: Sha, parents: Schema.Array(Schema.Struct({ sha: Sha })) });
const decodeSnapshot = Schema.decodeUnknownEffect(
  Schema.Struct({ baseSha: Schema.NullOr(Sha), headSha: Sha }),
);
type DiffInput = Parameters<PullRequestProviderApi["getDiff"]>[0];
type FileInput = Parameters<NonNullable<PullRequestProviderApi["getDiffFileContents"]>>[0];
const unavailable = (detail: string) => new ForgejoApiError({ reason: "invalid-response", detail });

export const make = Effect.gen(function* () {
  const api = yield* ForgejoApi;
  const revisions = Effect.fn("ForgejoPullRequestDiff.revisions")(function* (
    input: DiffInput,
    path: string,
  ) {
    if (input.commit !== undefined) {
      const sha = yield* decodeSha(input.commit).pipe(
        Effect.mapError(() => unavailable("Use a full commit SHA.")),
      );
      const commit = yield* api.request({
        host: input.host,
        path: `${path}/git/commits/${sha}`,
        schema: Commit,
      });
      return { old: commit.parents[0]?.sha ?? null, new: commit.sha };
    }
    const [pull, refs] = yield* Effect.all(
      [
        api.request({ host: input.host, path: `${path}/pulls/${input.number}`, schema: Pull }),
        api.request({
          host: input.host,
          path: `${path}/git/refs/pull/${input.number}/head`,
          schema: Refs,
        }),
      ],
      { concurrency: 2 },
    );
    const head = refs.find((ref) => ref.ref === `refs/pull/${input.number}/head`);
    if (!head) return yield* unavailable("The pull request's exact diff revision is unavailable.");
    return { old: pull.merge_base, new: head.object.sha };
  });

  const getDiff = Effect.fn("ForgejoPullRequestDiff.getDiff")(function* (input: DiffInput) {
    if (input.cursor) return yield* unavailable("Forgejo raw diffs do not support cursors.");
    const path = yield* repositoryPath(input);
    const before = yield* revisions(input, path);
    const result = yield* api.requestText({
      host: input.host,
      path:
        input.commit === undefined
          ? `${path}/pulls/${input.number}.diff`
          : `${path}/git/commits/${before.new}.diff`,
    });
    if (input.commit === undefined) {
      const after = yield* revisions(input, path);
      if (before.old !== after.old || before.new !== after.new)
        return yield* unavailable(
          "The pull request changed while its diff was loading. Refresh it.",
        );
    }
    return {
      patch: result.text,
      truncated:
        result.truncated ||
        result.invalidUtf8 ||
        /^(?:Binary files .+ differ|GIT binary patch)$/mu.test(result.text),
      nextCursor: null,
      snapshot: { baseSha: before.old, headSha: before.new },
    };
  });

  const getDiffFileContents = Effect.fn("ForgejoPullRequestDiff.getDiffFileContents")(function* (
    input: FileInput,
  ) {
    const path = yield* repositoryPath(input);
    if (!input.snapshot) return yield* unavailable("Reload the diff before expanding this file.");
    const snapshot = yield* decodeSnapshot(input.snapshot).pipe(
      Effect.mapError(() => unavailable("The diff snapshot does not contain exact revisions.")),
    );
    if (input.commit !== undefined && input.commit !== snapshot.headSha)
      return yield* unavailable("The diff snapshot belongs to a different commit.");
    const read = Effect.fn("ForgejoPullRequestDiff.readFile")(function* (
      revision: string | null,
      name: string,
    ) {
      if (!revision) return yield* unavailable("The requested old revision does not exist.");
      const parts = name.split("/");
      if (parts.some((part) => !part || part === "." || part === "..") || /[\0\\]/u.test(name))
        return yield* unavailable("Use a repository-relative file path.");
      const result = yield* api.requestText({
        host: input.host,
        path: `${path}/raw/${parts.map(encodeURIComponent).join("/")}?ref=${revision}`,
      });
      if (result.truncated || result.invalidUtf8 || result.text.includes("\0"))
        return yield* unavailable("The full file is too large or is not UTF-8 text.");
      return result.text;
    });
    const [oldContents, newContents] = yield* Effect.all(
      [
        input.changeType === "new" ? Effect.succeed("") : read(snapshot.baseSha, input.oldPath),
        input.changeType === "deleted" ? Effect.succeed("") : read(snapshot.headSha, input.newPath),
      ],
      { concurrency: 2 },
    );
    return { oldContents, newContents };
  });
  return { getDiff, getDiffFileContents };
});
