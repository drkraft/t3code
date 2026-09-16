import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";
import * as Provider from "./ForgejoSourceControlProvider.ts";
import {
  harness,
  context,
  fork,
  pullRequest,
  repository,
  requestBody,
} from "./forgejoSourceControlTestUtils.ts";

it.effect("filters fork identity and merged state across all listing pages", () => {
  const { layer, requests } = harness((request) =>
    request.url.includes("page=2")
      ? Response.json([{ ...pullRequest, state: "closed", merged: true }])
      : Response.json(
          [
            { ...pullRequest, state: "closed" },
            { ...pullRequest, head: { ...pullRequest.head, repo: repository }, merged: true },
          ],
          { headers: { link: '<?page=2>; rel="next"' } },
        ),
  );
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    const prs = yield* provider.listChangeRequests({
      cwd: "/repo",
      context,
      headSelector: "feature",
      source: { refName: "feature", owner: "alice", repository: "renamed" },
      state: "merged",
      limit: 1,
    });
    assert.strictEqual(prs.length, 1);
    assert.strictEqual(prs[0]?.state, "merged");
    assert.strictEqual(prs[0]?.headRepositoryNameWithOwner, "alice/renamed");
    assert.strictEqual(requests.length, 2);
  }).pipe(Effect.provide(layer));
});
it.effect("reads a PR URL only from the selected repository", () => {
  const { layer, requests } = harness(() => Response.json(pullRequest));
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    const pr = yield* provider.getChangeRequest({
      cwd: "/repo",
      context,
      reference: pullRequest.html_url,
    });
    assert.strictEqual(pr.number, 42);
    assert.strictEqual(
      requests[0]?.url,
      "https://forge.example/api/v1/repos/team/project/pulls/42",
    );
  }).pipe(Effect.provide(layer));
});
it.effect("rejects a foreign PR URL before HTTP", () => {
  const { layer, requests } = harness(() => Response.json(pullRequest));
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    assert.isTrue(
      Result.isFailure(
        yield* provider
          .getChangeRequest({
            cwd: "/repo",
            context,
            reference: "https://other.example/team/project/pulls/42",
          })
          .pipe(Effect.result),
      ),
    );
    assert.strictEqual(requests.length, 0);
  }).pipe(Effect.provide(layer));
});
it.effect("creates a renamed-fork PR with the exact body and owner branch selector", () => {
  const { layer, requests } = harness((request) =>
    Response.json(
      request.method === "POST" ? pullRequest : request.url.includes("/alice/") ? fork : repository,
    ),
  );
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${dir}/body`, "Template body\n");
    const provider = yield* Provider.make;
    yield* provider.createChangeRequest({
      cwd: dir,
      context,
      source: { refName: "feature", owner: "alice", repository: "renamed" },
      baseRefName: "develop",
      headSelector: "feature",
      title: "Improve feature",
      bodyFile: `${dir}/body`,
    });
    assert.deepStrictEqual(requestBody(requests.at(-1)), {
      title: "Improve feature",
      body: "Template body\n",
      base: "develop",
      head: "alice:feature",
    });
  }).pipe(Effect.scoped, Effect.provide(layer));
});
it.effect(
  "rejects a different source repository under the target owner before creating a PR",
  () => {
    const { layer, requests } = harness(() => Response.json(repository));
    return Effect.gen(function* () {
      const provider = yield* Provider.make;
      assert.isTrue(
        Result.isFailure(
          yield* provider
            .createChangeRequest({
              cwd: "/repo",
              context,
              source: { refName: "feature", owner: "team", repository: "other" },
              baseRefName: "develop",
              headSelector: "feature",
              title: "Improve feature",
              bodyFile: "/missing",
            })
            .pipe(Effect.result),
        ),
      );
      assert.isFalse(requests.some((request) => request.method === "POST"));
    }).pipe(Effect.provide(layer));
  },
);
it.effect("rejects a credential-bearing PR URL before HTTP", () => {
  const { layer, requests } = harness(() => Response.json(pullRequest));
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    assert.isTrue(
      Result.isFailure(
        yield* provider
          .getChangeRequest({
            cwd: "/repo",
            context,
            reference: "https://secret@forge.example/team/project/pulls/42",
          })
          .pipe(Effect.result),
      ),
    );
    assert.strictEqual(requests.length, 0);
  }).pipe(Effect.provide(layer));
});
it.effect("rejects PR creation in an empty target before reading a body or posting", () => {
  const { layer, requests } = harness(() => Response.json({ ...repository, empty: true }));
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    const result = yield* provider
      .createChangeRequest({
        cwd: "/repo",
        context,
        baseRefName: "develop",
        headSelector: "feature",
        title: "Improve",
        bodyFile: "/missing",
      })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    assert.isFalse(requests.some((request) => request.method === "POST"));
  }).pipe(Effect.provide(layer));
});
it.effect("lets Forgejo resolve a renamed fork when the caller supplies only its owner", () => {
  const { layer, requests } = harness((request) =>
    Response.json(request.method === "POST" ? pullRequest : repository),
  );
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${dir}/body`, "Body");
    const provider = yield* Provider.make;
    yield* provider.createChangeRequest({
      cwd: dir,
      context,
      baseRefName: "develop",
      headSelector: "alice:feature",
      title: "Improve",
      bodyFile: `${dir}/body`,
    });
    assert.strictEqual(requests.length, 2);
    assert.deepStrictEqual(requestBody(requests[1]), {
      title: "Improve",
      body: "Body",
      base: "develop",
      head: "alice:feature",
    });
  }).pipe(Effect.scoped, Effect.provide(layer));
});
