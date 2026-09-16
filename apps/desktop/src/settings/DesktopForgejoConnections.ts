import {
  DesktopForgejoConnectionInput,
  type DesktopForgejoState,
  ForgejoConnectionMetadata,
  ForgejoConnectionMetadataArray,
  type ForgejoBootstrapConnection,
  validateForgejoConnectionAuthorities,
} from "@t3tools/contracts";
import {
  Config,
  ConfigProvider,
  Context,
  Crypto,
  Effect,
  Encoding,
  FileSystem,
  Layer,
  Option,
  Schema,
  Semaphore,
} from "effect";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

const Registry = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.String,
  connections: Schema.Array(
    Schema.Struct({
      ...ForgejoConnectionMetadata.fields,
      encryptedToken: Schema.String.check(Schema.isMinLength(1)),
    }),
  ).check(Schema.makeFilter(validateForgejoConnectionAuthorities)),
});
type Registry = typeof Registry.Type;
const decodeRegistry = Schema.decodeEffect(Schema.fromJsonString(Registry));
const encodeRegistry = Schema.encodeEffect(Schema.fromJsonString(Registry));
const decodeInput = Schema.decodeEffect(DesktopForgejoConnectionInput);
const decodeMetadata = Schema.decodeEffect(ForgejoConnectionMetadataArray);
const emptyRegistry: Registry = { version: 1, revision: "", connections: [] };

export class DesktopForgejoConnectionsError extends Schema.TaggedError<DesktopForgejoConnectionsError>()(
  "DesktopForgejoConnectionsError",
  { message: Schema.String },
) {}
const failure = (message: string) => new DesktopForgejoConnectionsError({ message });
const sanitize = (message: string) => Effect.mapError(() => failure(message));
const metadata = (connection: ForgejoConnectionMetadata): ForgejoConnectionMetadata => ({
  id: connection.id,
  apiUrl: connection.apiUrl,
  gitHosts: connection.gitHosts,
  ...(connection.wipPrefixes === undefined ? {} : { wipPrefixes: connection.wipPrefixes }),
});

export class DesktopForgejoConnections extends Context.Service<
  DesktopForgejoConnections,
  {
    readonly get: Effect.Effect<DesktopForgejoState, DesktopForgejoConnectionsError>;
    readonly upsert: (
      input: DesktopForgejoConnectionInput,
    ) => Effect.Effect<DesktopForgejoState, DesktopForgejoConnectionsError>;
    readonly remove: (
      id: string,
    ) => Effect.Effect<DesktopForgejoState, DesktopForgejoConnectionsError>;
    readonly loadForBootstrap: Effect.Effect<readonly ForgejoBootstrapConnection[] | undefined>;
  }
>()("@t3tools/desktop/settings/DesktopForgejoConnections") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const external = yield* Config.string("T3CODE_FORGEJO_CONNECTIONS").pipe(Config.option);
  const provider = yield* ConfigProvider.ConfigProvider;
  const externalParent = yield* provider.load(["T3CODE", "FORGEJO"]);
  const hasExternal =
    Option.isSome(external) ||
    (externalParent?._tag === "Record" && externalParent.keys.has("CONNECTIONS"));
  const source = hasExternal
    ? "external"
    : environment.platform === "darwin"
      ? "local"
      : "unsupported";
  const lock = yield* Semaphore.make(1);
  let activeRevision = "";
  let activeConnectionIds: readonly string[] = [];
  let error: string | null = null;
  const registryPath = environment.forgejoRegistryPath;
  const state = (document: Registry): DesktopForgejoState => ({
    source,
    connections: document.connections.map((entry) => ({ ...metadata(entry), hasToken: true })),
    pendingRestart: source === "local" && document.revision !== activeRevision,
    activeConnectionIds,
    error,
  });
  const read = fs.readFileString(registryPath).pipe(
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeed(null)
        : Effect.fail(failure("Cannot read the saved Forgejo configuration.")),
    ),
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed(emptyRegistry)
        : decodeRegistry(raw).pipe(
            sanitize("The saved Forgejo configuration is invalid or has an unsupported version."),
          ),
    ),
  );
  const checkEncryption = Effect.gen(function* () {
    const available = yield* safeStorage.isEncryptionAvailable.pipe(
      sanitize("Native encryption is unavailable."),
    );
    if (!available) return yield* failure("Native encryption is unavailable.");
  });
  const decrypt = Effect.fn("desktop.forgejo.decrypt")(function* (document: Registry) {
    if (document.connections.length > 0) yield* checkEncryption;
    return yield* Effect.forEach(document.connections, (entry) =>
      Effect.gen(function* () {
        const bytes = yield* Effect.fromResult(Encoding.decodeBase64(entry.encryptedToken)).pipe(
          sanitize("Cannot decrypt the saved Forgejo configuration."),
        );
        const token = yield* safeStorage
          .decryptString(bytes)
          .pipe(sanitize("Cannot decrypt the saved Forgejo configuration."));
        if (!token.trim()) return yield* failure("Cannot decrypt the saved Forgejo configuration.");
        return { ...metadata(entry), token };
      }),
    );
  });
  const write = Effect.fn("desktop.forgejo.write")(function* (
    connections: Registry["connections"],
  ) {
    const revision = yield* crypto.randomUUIDv4.pipe(
      sanitize("Cannot save the Forgejo configuration."),
    );
    const document: Registry = { version: 1, revision, connections };
    const encoded = yield* encodeRegistry(document).pipe(
      sanitize("Cannot encode the Forgejo configuration."),
    );
    const tempPath = `${registryPath}.${revision}.tmp`;
    yield* fs.makeDirectory(environment.stateDir, { recursive: true });
    yield* fs.writeFileString(tempPath, encoded, { mode: 0o600, flag: "wx" });
    yield* fs
      .rename(tempPath, registryPath)
      .pipe(Effect.onError(() => fs.remove(tempPath).pipe(Effect.ignore)));
    error = null;
    return state(document);
  }, sanitize("Cannot save the Forgejo configuration."));
  const writable = Effect.gen(function* () {
    if (source !== "local")
      return yield* failure("This Forgejo configuration is managed externally or unsupported.");
    const document = yield* read;
    yield* checkEncryption;
    yield* decrypt(document);
    return document;
  });
  const recordError = <A, R>(effect: Effect.Effect<A, DesktopForgejoConnectionsError, R>) =>
    effect.pipe(
      Effect.tapError((cause) =>
        Effect.sync(() => {
          error = cause.message;
        }),
      ),
    );
  return DesktopForgejoConnections.of({
    get: lock.withPermit(
      source !== "local"
        ? Effect.succeed(state(emptyRegistry))
        : read.pipe(
            Effect.map(state),
            Effect.catch((cause) =>
              Effect.sync(() => {
                error = cause.message;
                return state(emptyRegistry);
              }),
            ),
          ),
    ),
    upsert: Effect.fn("desktop.forgejo.upsert")(
      function* (raw) {
        const input = yield* decodeInput(raw).pipe(
          sanitize(
            "Invalid Forgejo connection. Check the address, identifier, authorities and token.",
          ),
        );
        const document = yield* writable;
        const existing = document.connections.find((entry) => entry.id === input.id);
        if (
          input.token === undefined &&
          (!existing || new URL(existing.apiUrl).origin !== new URL(input.apiUrl).origin)
        ) {
          return yield* failure(
            "A token is required for a new connection or a changed API origin.",
          );
        }
        const nextMetadata = metadata(input);
        const others = document.connections.filter((entry) => entry.id !== input.id);
        yield* decodeMetadata([...others, nextMetadata]).pipe(
          sanitize("Forgejo connections must have unique identifiers and Git authorities."),
        );
        const encryptedToken =
          input.token === undefined
            ? existing?.encryptedToken
            : Encoding.encodeBase64(
                yield* safeStorage
                  .encryptString(input.token)
                  .pipe(sanitize("Cannot encrypt the Forgejo token.")),
              );
        if (encryptedToken === undefined) return yield* failure("A token is required.");
        return yield* write([...others, { ...nextMetadata, encryptedToken }]);
      },
      lock.withPermit,
      recordError,
    ),
    remove: Effect.fn("desktop.forgejo.remove")(
      function* (id) {
        const document = yield* writable;
        if (!document.connections.some((entry) => entry.id === id)) return state(document);
        return yield* write(document.connections.filter((entry) => entry.id !== id));
      },
      lock.withPermit,
      recordError,
    ),
    loadForBootstrap: lock.withPermit(
      Effect.gen(function* () {
        if (source !== "local") return undefined;
        const document = yield* read;
        const connections = yield* decrypt(document);
        activeRevision = document.revision;
        activeConnectionIds = connections.map((entry) => entry.id);
        error = null;
        return connections;
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            error = cause.message;
            activeRevision = "";
            activeConnectionIds = [];
            return [];
          }),
        ),
      ),
    ),
  });
});
export const layer = Layer.effect(DesktopForgejoConnections, make);
