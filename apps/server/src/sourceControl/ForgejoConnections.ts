import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";

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

function authority(value: string): string | null {
  const url = URL.parse(`ssh://${value}`);
  return url &&
    url.hostname &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.pathname === "" || url.pathname === "/") &&
    !/[\s/\\]/u.test(value)
    ? url.host.toLowerCase()
    : null;
}

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
  return authority(scpAuthority ?? value);
}

const ConnectionConfig = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
  apiUrl: Schema.String.check(
    Schema.makeFilter((value) => {
      const url = URL.parse(value);
      return (
        url !== null &&
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        /\/api\/v1\/?$/u.test(url.pathname) &&
        !/[\s\\]/u.test(value)
      );
    }),
  ),
  gitHosts: Schema.Array(
    Schema.String.check(Schema.makeFilter((value) => authority(value) !== null)),
  ),
  tokenEnv: Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u)),
  wipPrefixes: Schema.optional(Schema.Array(Schema.String.check(Schema.isPattern(/\S/u)))),
});

const decodeConnections = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(ConnectionConfig)),
);

export const make = Effect.gen(function* () {
  const raw = yield* Config.string("T3CODE_FORGEJO_CONNECTIONS").pipe(
    Config.withDefault("[]"),
    Effect.mapError(
      () =>
        new ForgejoConnectionsConfigError({
          message: "Cannot read Forgejo connection configuration.",
        }),
    ),
  );
  const configs = yield* decodeConnections(raw).pipe(
    Effect.mapError(
      () =>
        new ForgejoConnectionsConfigError({
          message: "Invalid T3CODE_FORGEJO_CONNECTIONS configuration.",
        }),
    ),
  );
  const byAuthority = new Map<string, ForgejoConnection>();
  const ids = new Set<string>();
  const connections: ForgejoConnection[] = [];
  for (const config of configs) {
    if (ids.has(config.id)) {
      return yield* new ForgejoConnectionsConfigError({
        message: "Duplicate Forgejo connection id.",
      });
    }
    ids.add(config.id);
    const apiAuthority = remoteAuthority(config.apiUrl);
    const apiUrl = new URL(config.apiUrl);
    const hosts = new Set(config.gitHosts.map((host) => authority(host) ?? host.toLowerCase()));
    if (apiAuthority) hosts.add(apiAuthority);
    const token = yield* Config.redacted(config.tokenEnv).pipe(
      Config.option,
      Effect.mapError(
        () =>
          new ForgejoConnectionsConfigError({
            message: "Cannot read Forgejo credential configuration.",
          }),
      ),
    );
    const connection: ForgejoConnection = {
      id: config.id,
      apiUrl: apiUrl.href.replace(/\/$/u, ""),
      gitHosts: [...hosts],
      ...(config.wipPrefixes === undefined ? {} : { wipPrefixes: config.wipPrefixes }),
      token: Option.filter(token, (value) => Redacted.value(value).trim() !== ""),
    };
    for (const host of hosts) {
      if (byAuthority.has(host)) {
        return yield* new ForgejoConnectionsConfigError({
          message: "Forgejo connections share an ambiguous Git authority.",
        });
      }
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
