import { Effect, Schema } from "effect";
import * as Api from "./ForgejoApi.ts";
import * as Connections from "./ForgejoConnections.ts";
import * as VcsRegistry from "../vcs/VcsDriverRegistry.ts";
import type { SourceControlProviderContext } from "./SourceControlProvider.ts";

export const Repository = Schema.Struct({
  id: Schema.Int,
  full_name: Schema.NonEmptyString,
  clone_url: Schema.NonEmptyString,
  ssh_url: Schema.NonEmptyString,
  default_branch: Schema.String,
  empty: Schema.Boolean,
  parent: Schema.optional(
    Schema.NullOr(Schema.Struct({ id: Schema.Int, full_name: Schema.NonEmptyString })),
  ),
});
export interface RepositoryRef {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}
export const repositoryPath = (ref: RepositoryRef) =>
  `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
export const cloneUrls = (repo: typeof Repository.Type) => ({
  nameWithOwner: repo.full_name,
  url: repo.clone_url,
  sshUrl: repo.ssh_url,
});
export const failure = (detail: string) =>
  new Api.ForgejoApiError({ reason: "configuration", detail });
const Part = Schema.String.check(
  Schema.isPattern(/^[^/\\:?#\s]+$/u),
  Schema.makeFilter((value) => value !== "." && value !== ".."),
);
const Slug = Schema.Tuple([Part, Part]);
const decodeSlug = Schema.decodeUnknownOption(Slug);

export const make = Effect.gen(function* () {
  const api = yield* Api.ForgejoApi;
  const connections = yield* Connections.make;
  const registry = yield* VcsRegistry.VcsDriverRegistry;
  const parse = (value: string): RepositoryRef | null => {
    const connection = api.resolveConnection(value);
    if (!connection) return null;
    const url = URL.parse(value);
    if (url && /^https?:$/u.test(url.protocol) && url.username) return null;
    const path = url ? url.pathname : /^[^@/]+@[^:]+:(.+)$/u.exec(value)?.[1];
    if (!path) return null;
    const prefix = new URL(connection.apiUrl).pathname.replace(/\/api\/v1$/u, "");
    const relative =
      url && /^https?:$/u.test(url.protocol) && prefix && path.startsWith(`${prefix}/`)
        ? path.slice(prefix.length)
        : path;
    const parts = decodeSlug(
      relative
        .replace(/^\/|\/$/gu, "")
        .replace(/\.git$/u, "")
        .split("/"),
    );
    return parts._tag === "Some"
      ? { host: new URL(connection.apiUrl).host, owner: parts.value[0], name: parts.value[1] }
      : null;
  };
  const resolve = Effect.fn("ForgejoRepository.resolve")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly repository?: string;
  }) {
    if (input.repository?.includes(":") || input.repository?.includes("@")) {
      const explicit = parse(input.repository);
      if (!explicit)
        return yield* failure(
          "The repository URL must identify a configured Forgejo instance and owner/repository.",
        );
      return explicit;
    }
    const slug =
      input.repository === undefined ? undefined : decodeSlug(input.repository.split("/"));
    if (slug?._tag === "None")
      return yield* failure("Use owner/repository or a configured Forgejo repository URL.");
    let selected: RepositoryRef | null = null;
    if (input.context) {
      selected = input.context.provider.kind === "forgejo" ? parse(input.context.remoteUrl) : null;
      if (!selected)
        return yield* failure(
          "The selected remote does not match a configured Forgejo repository.",
        );
    } else {
      const handle = yield* registry.detect({ cwd: input.cwd });
      if (handle) {
        const { remotes } = yield* handle.driver.listRemotes(input.cwd);
        const candidates = remotes
          .map((remote) => ({ remote, ref: parse(remote.url) }))
          .filter((item) => item.ref !== null);
        const primary = candidates.find((item) => item.remote.isPrimary);
        selected = primary?.ref ?? (candidates.length === 1 ? (candidates[0]?.ref ?? null) : null);
        if (!selected && candidates.length > 1)
          return yield* failure(
            "Select a Forgejo remote explicitly; this workspace has multiple matching repositories.",
          );
      }
    }
    if (slug?._tag === "Some") {
      const connection =
        connections.connections.length === 1 ? connections.connections[0] : undefined;
      const host = selected?.host ?? (connection ? new URL(connection.apiUrl).host : undefined);
      if (!host) return yield* failure("Use a full repository URL to select the Forgejo instance.");
      return { host, owner: slug.value[0], name: slug.value[1] };
    }
    if (!selected)
      return yield* failure("No configured Forgejo repository was found in this workspace.");
    return selected;
  });
  const get = (ref: RepositoryRef) =>
    api.request({ host: ref.host, path: repositoryPath(ref), schema: Repository });
  const validateCloneUrls = (repo: typeof Repository.Type, host: string) => {
    const connection = api.resolveConnection(host);
    return [repo.clone_url, repo.ssh_url].every((url) => {
      const ref = parse(url);
      return (
        api.resolveConnection(url)?.id === connection?.id &&
        ref !== null &&
        `${ref.owner}/${ref.name}`.toLowerCase() === repo.full_name.toLowerCase()
      );
    });
  };
  return { parse, resolve, get, api, validateCloneUrls };
});
