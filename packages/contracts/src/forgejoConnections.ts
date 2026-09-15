import * as Schema from "effect/Schema";

export function normalizeForgejoAuthority(value: string): string | null {
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

export const ForgejoConnectionMetadata = Schema.Struct({
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
        /^\/api\/v1\/?$/u.test(url.pathname) &&
        !/[\s\\]/u.test(value)
      );
    }),
  ),
  gitHosts: Schema.Array(
    Schema.String.check(Schema.makeFilter((value) => normalizeForgejoAuthority(value) !== null)),
  ),
  wipPrefixes: Schema.optional(Schema.Array(Schema.String.check(Schema.isPattern(/\S/u)))),
});

export type ForgejoConnectionMetadata = typeof ForgejoConnectionMetadata.Type;

// Validate the complete set so aliases cannot resolve to more than one connection.
export function validateForgejoConnectionAuthorities(
  connections: readonly ForgejoConnectionMetadata[],
): true | string {
  const ids = new Set<string>();
  const authorities = new Set<string>();
  for (const connection of connections) {
    if (ids.has(connection.id)) return "Duplicate Forgejo connection id.";
    ids.add(connection.id);
    const hosts = new Set(connection.gitHosts.map((host) => normalizeForgejoAuthority(host)));
    hosts.add(new URL(connection.apiUrl).host.toLowerCase());
    for (const host of hosts) {
      if (host === null) continue;
      if (authorities.has(host)) return "Forgejo connections share an ambiguous Git authority.";
      authorities.add(host);
    }
  }
  return true;
}

export const ForgejoConnectionMetadataArray = Schema.Array(ForgejoConnectionMetadata).check(
  Schema.makeFilter(validateForgejoConnectionAuthorities),
);

export const ForgejoBootstrapConnection = Schema.Struct({
  ...ForgejoConnectionMetadata.fields,
  token: Schema.String,
});
export type ForgejoBootstrapConnection = typeof ForgejoBootstrapConnection.Type;

export const ForgejoBootstrapConnections = Schema.Array(ForgejoBootstrapConnection).check(
  Schema.makeFilter(validateForgejoConnectionAuthorities),
);
