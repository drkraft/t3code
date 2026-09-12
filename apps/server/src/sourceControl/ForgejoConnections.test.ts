import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option, Redacted, Schema } from "effect";

import { ForgejoConnections, ForgejoConnectionsConfigError } from "./ForgejoConnections.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const primary = {
  id: "primary",
  apiUrl: "https://forge.example/forge/api/v1/",
  gitHosts: ["ForgeSSH", "forge.example:2222"],
  tokenEnv: "FORGE_TOKEN",
};

const connectionLayer = (raw?: string, extraEnv: Record<string, string> = {}) =>
  ForgejoConnections.layer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: { ...(raw === undefined ? {} : { T3CODE_FORGEJO_CONNECTIONS: raw }), ...extraEnv },
        }),
      ),
    ),
  );

const load = (raw?: string, extraEnv: Record<string, string> = {}) =>
  Effect.service(ForgejoConnections).pipe(Effect.provide(connectionLayer(raw, extraEnv)));

describe("ForgejoConnections", () => {
  it.effect("leaves other providers available when no connections are configured", () =>
    Effect.gen(function* () {
      const service = yield* load();
      expect(service.connections).toEqual([]);
      expect(service.resolve("git@github.com:owner/repo.git")).toBeNull();
    }),
  );

  it.effect("normalizes aliases and keeps the API instance subpath", () =>
    Effect.gen(function* () {
      const service = yield* load(encodeJson([primary]));
      expect(service.resolve("git@FORGESSH:owner/repo.git")?.apiUrl).toBe(
        "https://forge.example/forge/api/v1",
      );
      expect(service.resolve("https://forge.example/forge/owner/repo.git")?.id).toBe("primary");
    }),
  );

  it.effect("selects the correct instance for identical repository names", () =>
    Effect.gen(function* () {
      const service = yield* load(
        encodeJson([
          primary,
          {
            ...primary,
            id: "secondary",
            apiUrl: "https://other.example/api/v1",
            gitHosts: ["other-ssh"],
          },
        ]),
      );
      expect(service.resolve("git@ForgeSSH:owner/repo.git")?.id).toBe("primary");
      expect(service.resolve("git@other-ssh:owner/repo.git")?.id).toBe("secondary");
      expect(service.resolve("git@unknown:owner/repo.git")).toBeNull();
    }),
  );

  it.effect("matches explicit SSH ports exactly", () =>
    Effect.gen(function* () {
      const service = yield* load(encodeJson([primary]));
      expect(service.resolve("ssh://git@forge.example:2222/owner/repo.git")?.id).toBe("primary");
      expect(service.resolve("ssh://git@forge.example:2223/owner/repo.git")).toBeNull();
      expect(service.resolve("ssh://git@forge.example:443/owner/repo.git")).toBeNull();
      expect(service.resolve("forge.example:2222")?.id).toBe("primary");
    }),
  );

  it.effect("canonicalizes HTTPS default ports and casing", () =>
    Effect.gen(function* () {
      const service = yield* load(
        encodeJson([{ ...primary, apiUrl: "https://FORGE.example:443/api/v1/" }]),
      );
      expect(service.resolve("https://forge.example:443/owner/repo.git")?.apiUrl).toBe(
        "https://forge.example/api/v1",
      );
      expect(service.resolve("forge.example")?.id).toBe("primary");
    }),
  );

  it.effect.each([
    "ftp://forge.example/owner/repo.git",
    "https://user:secret@forge.example/owner/repo.git",
    "https://forge.example/owner/repo.git?token=secret",
    "https://forge.example/owner/repo.git#fragment",
  ])("rejects unsupported or credential-bearing remote URLs (%#)", (remote) =>
    Effect.gen(function* () {
      const service = yield* load(encodeJson([primary]));
      expect(service.resolve(remote)).toBeNull();
    }),
  );

  it.effect("supports explicitly configured local HTTP instances", () =>
    Effect.gen(function* () {
      const service = yield* load(
        encodeJson([{ ...primary, apiUrl: "http://localhost:3000/api/v1" }]),
      );
      expect(service.resolve("http://localhost:3000/owner/repo")?.id).toBe("primary");
      expect(service.resolve("localhost")).toBeNull();
    }),
  );

  it.effect("keeps a missing credential local to its connection", () =>
    Effect.gen(function* () {
      const service = yield* load(encodeJson([primary]));
      expect(Option.isNone(service.resolve("ForgeSSH")?.token ?? Option.none())).toBe(true);
    }),
  );

  it.effect("reads the configured token variable and redacts serialized connections", () =>
    Effect.gen(function* () {
      const service = yield* load(encodeJson([primary]), { FORGE_TOKEN: "test-secret" });
      const connection = service.resolve("ForgeSSH");
      expect(connection).not.toBeNull();
      expect(Option.map(connection?.token ?? Option.none(), Redacted.value)).toEqual(
        Option.some("test-secret"),
      );
      expect(encodeJson(service.connections)).not.toContain("test-secret");
    }),
  );

  it.effect.each([
    "not-json",
    "{}",
    encodeJson([{ ...primary, tokenEnv: "BAD TOKEN" }]),
    encodeJson([{ ...primary, apiUrl: "https://user:secret@forge.example/api/v1" }]),
    encodeJson([{ ...primary, apiUrl: "https://forge.example/api/v1?token=secret" }]),
    encodeJson([{ ...primary, apiUrl: "https://forge.example/api/v1#secret" }]),
    encodeJson([{ ...primary, apiUrl: "ftp://forge.example/api/v1" }]),
    encodeJson([{ ...primary, apiUrl: "https://forge.example" }]),
    encodeJson([{ ...primary, gitHosts: ["https://forge.example"] }]),
    encodeJson([primary, { ...primary, apiUrl: "https://other.example/api/v1", gitHosts: [] }]),
    encodeJson([primary, { ...primary, id: "second" }]),
    encodeJson([
      primary,
      { ...primary, id: "second", apiUrl: "https://other.example/api/v1", gitHosts: ["FORGESSH"] },
    ]),
  ])("rejects malformed or ambiguous configuration without echoing values (%#)", (raw) =>
    Effect.gen(function* () {
      const result = yield* Effect.service(ForgejoConnections).pipe(
        Effect.provide(connectionLayer(raw)),
        Effect.flip,
      );
      expect(result).toBeInstanceOf(ForgejoConnectionsConfigError);
      expect(encodeJson(result)).not.toContain(raw);
      expect(encodeJson(result)).not.toContain("secret");
    }),
  );
});
