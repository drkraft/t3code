import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { refineUnknownRemoteProvider } from "./SourceControlProviderDiscovery.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

for (const kind of ["unknown", "github"] as const) {
  it.effect(`resolves configured API hosts ahead of ${kind} DNS detection without a CLI`, () =>
    Effect.gen(function* () {
      const context = {
        provider: { kind, name: "git.internal", baseUrl: "https://git.internal" },
        remoteName: "origin",
        remoteUrl: "ssh://git@git.internal:2222/team/project.git",
      };
      const provider = {
        kind: "forgejo" as const,
        name: "Forgejo",
        baseUrl: "https://forge.example",
      };
      const resolved = yield* refineUnknownRemoteProvider({
        cwd: "/project",
        context,
        process: VcsProcess.VcsProcess.of({ run: () => Effect.die("Unexpected CLI request") }),
        specs: [
          {
            kind: "forgejo",
            label: "Forgejo",
            installHint: "Configure an instance.",
            type: "api",
            probeAuth: Effect.succeed({
              status: "unknown",
              account: Option.none(),
              host: Option.none(),
              detail: Option.none(),
            }),
            resolveRemote: (remote) => (remote === context.remoteUrl ? provider : null),
          },
        ],
      });
      assert.deepEqual(resolved, { ...context, provider });
    }),
  );
}

it.effect("keeps known hosts unchanged when no configured API instance matches", () =>
  Effect.gen(function* () {
    const context = {
      provider: { kind: "github" as const, name: "GitHub", baseUrl: "https://github.com" },
      remoteName: "origin",
      remoteUrl: "git@github.com:team/project.git",
    };
    const resolved = yield* refineUnknownRemoteProvider({
      cwd: "/project",
      context,
      specs: [],
      process: VcsProcess.VcsProcess.of({ run: () => Effect.die("Unexpected CLI request") }),
    });
    assert.deepEqual(resolved, context);
  }),
);
