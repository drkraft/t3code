import {
  ForgejoConnectionMetadata,
  normalizeForgejoAuthority,
  validateForgejoConnectionAuthorities,
} from "@t3tools/contracts";
import { Config, ConfigProvider, Context, Effect, Layer, Option, Redacted, Schema } from "effect";

import { ServerConfig } from "../config.ts";

export interface ForgejoConnection {
  readonly id: string;
  readonly apiUrl: string;
  readonly gitHosts: readonly string[];
  readonly wipPrefixes?: readonly string[];
  readonly token: Option.Option<Redacted.Redacted<string>>;
}

export class ForgejoConnectionsConfigError extends Schema.TaggedError<ForgejoConnectionsConfigError>()(
  "ForgejoConnectionsConfigError",
  { message: Schema.String },
) {}

function remoteAuthority(value: string): string | null {
  if (value.includes("://")) {
    const url = URL.parse(value);
    return url &&
      ["https:", "http:", "ssh:", "git:"].includes(url.protocol) &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/[\s\\]/u.test(value)
      ? url.host.toLowerCase()
      : null;
  }
  const scpAuthority = /^[^@/\s]+@(\[[^\]]+\]|[^:/\s]+):.+$/u.exec(value)?.[1];
  return normalizeForgejoAuthority(scpAuthority ?? value);
}

const ConnectionConfig = Schema.Struct({
  ...ForgejoConnectionMetadata.fields,
  tokenEnv: Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u)),
});

const decodeConnections = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(ConnectionConfig)),
);

export const make = Effect.gen(function* () {
  const raw = yield* Config.string("T3CODE_FORGEJO_CONNECTIONS").pipe(
    Config.option,
    Effect.mapError(
      () =>
        new ForgejoConnectionsConfigError({
          message: "Cannot read Forgejo connection configuration.",
        }),
    ),
  );
  const provider = yield* ConfigProvider.ConfigProvider;
  // Environment providers omit empty scalar values but retain their child keys.
  const parent = yield* provider.load(["T3CODE", "FORGEJO"]).pipe(
    Effect.mapError(
      () =>
        new ForgejoConnectionsConfigError({
          message: "Cannot read Forgejo connection configuration.",
        }),
    ),
  );
  const hasExternal =
    Option.isSome(raw) || (parent?._tag === "Record" && parent.keys.has("CONNECTIONS"));
  const serverConfig = yield* Effect.serviceOption(ServerConfig);
  const configs = hasExternal
    ? yield* decodeConnections(Option.getOrElse(raw, () => "")).pipe(
        Effect.mapError(
          () =>
            new ForgejoConnectionsConfigError({
              message: "Invalid T3CODE_FORGEJO_CONNECTIONS configuration.",
            }),
        ),
        Effect.flatMap((configs) =>
          Effect.forEach(configs, (config) =>
            Config.redacted(config.tokenEnv).pipe(
              Config.option,
              Effect.mapError(
                () =>
                  new ForgejoConnectionsConfigError({
                    message: "Cannot read Forgejo credential configuration.",
                  }),
              ),
              Effect.map((token) => ({ ...config, token })),
            ),
          ),
        ),
      )
    : (Option.getOrUndefined(serverConfig)?.forgejoConnections ?? []).map((config) => ({
        ...config,
        token: Option.some(Redacted.make(config.token)),
      }));
  const byAuthority = new Map<string, ForgejoConnection>();
  const validation = validateForgejoConnectionAuthorities(configs);
  if (validation !== true) {
    return yield* new ForgejoConnectionsConfigError({ message: validation });
  }
  const connections: ForgejoConnection[] = [];
  for (const config of configs) {
    const apiAuthority = remoteAuthority(config.apiUrl);
    const apiUrl = new URL(config.apiUrl);
    const hosts = new Set(
      config.gitHosts.map((host) => normalizeForgejoAuthority(host) ?? host.toLowerCase()),
    );
    if (apiAuthority) hosts.add(apiAuthority);
    const connection: ForgejoConnection = {
      id: config.id,
      apiUrl: apiUrl.href.replace(/\/$/u, ""),
      gitHosts: [...hosts],
      ...(config.wipPrefixes === undefined ? {} : { wipPrefixes: config.wipPrefixes }),
      token: Option.filter(config.token, (value) => Redacted.value(value).trim() !== ""),
    };
    for (const host of hosts) {
      byAuthority.set(host, connection);
    }
    connections.push(connection);
  }
  return {
    connections,
    resolve: (remoteUrlOrHost: string) => {
      const host = remoteAuthority(remoteUrlOrHost);
      return host ? (byAuthority.get(host) ?? null) : null;
    },
  };
});

export class ForgejoConnections extends Context.Service<
  ForgejoConnections,
  {
    readonly connections: readonly ForgejoConnection[];
    readonly resolve: (remoteUrlOrHost: string) => ForgejoConnection | null;
  }
>()("t3/sourceControl/ForgejoConnections") {
  static readonly layer = Layer.effect(ForgejoConnections, make);
}

export const layer = ForgejoConnections.layer;
