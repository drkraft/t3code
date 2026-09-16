import { assert, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import * as Provider from "./ForgejoSourceControlProvider.ts";
import { harness, context, repository, requestBody } from "./forgejoSourceControlTestUtils.ts";

it.effect("returns server clone URLs for the explicitly configured SSH alias", () => {
  const { layer } = harness(() => Response.json(repository));
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    const urls = yield* provider.getRepositoryCloneUrls({
      cwd: "/repo",
      context,
      repository: "team/project",
    });
    assert.deepStrictEqual(urls, {
      nameWithOwner: "team/project",
      url: repository.clone_url,
      sshUrl: repository.ssh_url,
    });
  }).pipe(Effect.provide(layer));
});
for (const empty of [true, false])
  it.effect(`returns the correct default branch when empty=${empty}`, () => {
    const { layer } = harness(() => Response.json({ ...repository, empty }));
    return Effect.gen(function* () {
      const provider = yield* Provider.make;
      assert.strictEqual(
        yield* provider.getDefaultBranch({ cwd: "/repo", context }),
        empty ? null : "develop",
      );
    }).pipe(Effect.provide(layer));
  });
for (const owner of ["operator", "team"])
  it.effect(`creates a private repository under ${owner}`, () => {
    const { layer, requests } = harness((request) =>
      Response.json(request.url.endsWith("/user") ? { id: 4, login: "operator" } : repository),
    );
    return Effect.gen(function* () {
      const provider = yield* Provider.make;
      yield* provider.createRepository({
        cwd: "/repo",
        repository: `${owner}/project`,
        visibility: "private",
      });
      assert.strictEqual(
        requests[1]?.url,
        `https://forge.example/api/v1/${owner === "operator" ? "user" : "orgs/team"}/repos`,
      );
      assert.deepStrictEqual(requestBody(requests[1]), {
        name: "project",
        private: true,
        auto_init: false,
      });
    }).pipe(Effect.provide(layer));
  });
it.effect("propagates denied creation without retrying", () => {
  const { layer, requests } = harness((request) =>
    request.url.endsWith("/user")
      ? Response.json({ id: 4, login: "operator" })
      : new Response("private server detail", { status: 403 }),
  );
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    const result = yield* provider
      .createRepository({ cwd: "/repo", repository: "team/project", visibility: "public" })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    assert.strictEqual(requests.length, 2);
  }).pipe(Effect.provide(layer));
});
it.effect("rejects ambiguous instance selection before sending a request", () => {
  const { layer, requests } = harness(() => Response.json(repository), true);
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    assert.isTrue(
      Result.isFailure(
        yield* provider
          .getRepositoryCloneUrls({ cwd: "/repo", repository: "team/project" })
          .pipe(Effect.result),
      ),
    );
    assert.strictEqual(requests.length, 0);
  }).pipe(Effect.provide(layer));
});
it.effect("routes an explicit repository URL to its configured instance", () => {
  const { layer, requests } = harness(
    () =>
      Response.json({
        ...repository,
        clone_url: "https://other.example/team/project.git",
        ssh_url: "git@other.example:team/project.git",
      }),
    true,
  );
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    yield* provider.getRepositoryCloneUrls({
      cwd: "/repo",
      repository: "https://other.example/team/project",
    });
    assert.strictEqual(requests[0]?.url, "https://other.example/api/v1/repos/team/project");
  }).pipe(Effect.provide(layer));
});
it.effect("rejects foreign clone URLs", () => {
  const { layer } = harness(() =>
    Response.json({ ...repository, ssh_url: "ssh://git@foreign.example/team/project.git" }),
  );
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    assert.isTrue(
      Result.isFailure(
        yield* provider
          .getRepositoryCloneUrls({ cwd: "/repo", context, repository: "team/project" })
          .pipe(Effect.result),
      ),
    );
  }).pipe(Effect.provide(layer));
});
