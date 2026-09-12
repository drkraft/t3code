import { Clock, Context, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { SourceControlProviderAuth } from "@t3tools/contracts";
import * as ForgejoConnections from "./ForgejoConnections.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { retryAtFromHeader } from "./SourceControlRateLimit.ts";

export class ForgejoApiError extends Schema.TaggedError<ForgejoApiError>()("ForgejoApiError", {
  reason: Schema.Literals([
    "configuration",
    "unauthenticated",
    "forbidden",
    "not-found",
    "rate-limited",
    "failed",
    "invalid-response",
    "invalid-url",
  ]),
  detail: Schema.String,
  status: Schema.optional(Schema.Int),
  retryAt: Schema.optional(Schema.Finite),
}) {}

interface RequestInput<S extends Schema.Top> {
  readonly host: string;
  readonly path: string;
  readonly schema: S;
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly body?: string;
}

const Viewer = Schema.Struct({ id: Schema.Int, login: Schema.NonEmptyString });

export class ForgejoApi extends Context.Service<
  ForgejoApi,
  {
    readonly request: <S extends Schema.Top>(
      input: RequestInput<S>,
    ) => Effect.Effect<S["Type"], ForgejoApiError, S["DecodingServices"]>;
    readonly page: <S extends Schema.Top>(
      input: RequestInput<S>,
    ) => Effect.Effect<
      { readonly items: ReadonlyArray<S["Type"]>; readonly next: string | null },
      ForgejoApiError,
      S["DecodingServices"]
    >;
    readonly getViewer: (host: string) => Effect.Effect<typeof Viewer.Type, ForgejoApiError>;
    readonly resolveConnection: ForgejoConnections.ForgejoConnections["Service"]["resolve"];
    readonly probeAuth: Effect.Effect<SourceControlProviderAuth>;
  }
>()("t3/sourceControl/ForgejoApi") {}

function apiUrl(base: string, path: string): string | null {
  if (path.startsWith("//") || /[\\\s]/u.test(path)) return null;
  const root = new URL(`${base}/`);
  const url = path.startsWith(root.pathname)
    ? URL.parse(path, root.origin)
    : URL.parse(path.replace(/^\/(?!\/)/u, ""), root.href);
  return url &&
    url.origin === root.origin &&
    url.pathname.startsWith(root.pathname) &&
    !url.username &&
    !url.password &&
    !url.hash
    ? url.href
    : null;
}

export const make = Effect.gen(function* () {
  const connections = yield* ForgejoConnections.make;
  const client = yield* HttpClient.HttpClient;
  const fail = (reason: ForgejoApiError["reason"], detail: string) =>
    new ForgejoApiError({ reason, detail });

  const send = Effect.fn("ForgejoApi.send")(
    function* (input: Omit<RequestInput<Schema.Top>, "schema">) {
      const connection = connections.resolve(input.host);
      if (!connection)
        return yield* fail("configuration", "No Forgejo connection matches this host.");
      if (Option.isNone(connection.token))
        return yield* fail("unauthenticated", "The Forgejo connection has no configured token.");
      const url = apiUrl(connection.apiUrl, input.path);
      if (!url)
        return yield* fail("invalid-url", "The request URL is outside the configured Forgejo API.");
      let request = HttpClientRequest.make(input.method ?? "GET")(url).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeader(
          "authorization",
          `token ${Redacted.value(connection.token.value)}`,
        ),
      );
      if (input.body !== undefined)
        request = request.pipe(HttpClientRequest.bodyText(input.body, "application/json"));
      const response = yield* client.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.mapError(() => fail("failed", "The Forgejo request could not be completed.")),
      );
      if (response.status >= 300 && response.status < 400) {
        return yield* fail("invalid-url", "Forgejo API redirects are not followed.");
      }
      if (response.status < 200 || response.status >= 300) {
        const now = yield* Clock.currentTimeMillis;
        const retryAt =
          response.status === 429
            ? retryAtFromHeader(response.headers["retry-after"], now)
            : undefined;
        const reasons = {
          401: "unauthenticated",
          403: "forbidden",
          404: "not-found",
          429: "rate-limited",
        } as const;
        const reason =
          response.status === 401 ||
          response.status === 403 ||
          response.status === 404 ||
          response.status === 429
            ? reasons[response.status]
            : "failed";
        return yield* new ForgejoApiError({
          reason,
          status: response.status,
          detail: `Forgejo returned HTTP ${response.status}.`,
          ...(retryAt === undefined ? {} : { retryAt }),
        });
      }
      const body = yield* collectUint8StreamText({
        stream: response.stream,
        maxBytes: 8 * 1024 * 1024,
      }).pipe(Effect.mapError(() => fail("failed", "The Forgejo response could not be read.")));
      if (body.truncated || body.invalidUtf8)
        return yield* fail(
          "invalid-response",
          "The Forgejo response exceeds the limit or is not valid UTF-8.",
        );
      return { text: body.text, link: response.headers.link, apiBase: connection.apiUrl, url };
    },
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () => fail("failed", "The Forgejo request timed out."),
    }),
  );

  const decode = <S extends Schema.Top>(schema: S, text: string) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError(() =>
        fail("invalid-response", "Forgejo returned an unexpected response format."),
      ),
    );
  const request: ForgejoApi["Service"]["request"] = (input) =>
    send(input).pipe(Effect.flatMap((response) => decode(input.schema, response.text)));
  const page: ForgejoApi["Service"]["page"] = (input) =>
    Effect.gen(function* () {
      const response = yield* send({ ...input, method: "GET" });
      const items = yield* decode(Schema.Array(input.schema), response.text);
      const nextLink = response.link
        ?.split(/,(?=\s*<)/u)
        .find((part) => /;\s*rel="?next"?(?:;|\s|$)/u.test(part));
      const target = nextLink ? /<([^>]+)>/u.exec(nextLink)?.[1] : undefined;
      const resolvedTarget = target ? URL.parse(target, response.url)?.href : undefined;
      const next = resolvedTarget ? apiUrl(response.apiBase, resolvedTarget) : null;
      if (nextLink && !next)
        return yield* fail("invalid-url", "The next page is outside the configured Forgejo API.");
      return { items, next };
    });
  const getViewer = (host: string) => request({ host, path: "/user", schema: Viewer });
  const probeAuth: ForgejoApi["Service"]["probeAuth"] = Effect.gen(function* () {
    if (connections.connections.length === 0)
      return {
        status: "unknown",
        account: Option.none(),
        host: Option.none(),
        detail: Option.some("Configure T3CODE_FORGEJO_CONNECTIONS on the server."),
      } satisfies SourceControlProviderAuth;
    const results = yield* Effect.forEach(
      connections.connections,
      (connection) => getViewer(connection.apiUrl).pipe(Effect.result),
      { concurrency: 4 },
    );
    const authenticated = results.some(Result.isSuccess);
    const single = connections.connections.length === 1 ? connections.connections[0] : undefined;
    const result = single ? results[0] : undefined;
    return {
      status: authenticated ? "authenticated" : "unauthenticated",
      account:
        result && Result.isSuccess(result) ? Option.some(result.success.login) : Option.none(),
      host: single ? Option.some(new URL(single.apiUrl).host) : Option.none(),
      detail: Option.some(
        connections.connections
          .map(
            (connection, index) =>
              `${connection.id} (${new URL(connection.apiUrl).host}): ${
                results[index]
                  ? Result.match(results[index], {
                      onSuccess: (viewer) => viewer.login,
                      onFailure: (error) => error.reason,
                    })
                  : "unavailable"
              }`,
          )
          .join("; "),
      ),
    } satisfies SourceControlProviderAuth;
  });
  return ForgejoApi.of({
    request,
    page,
    getViewer,
    resolveConnection: connections.resolve,
    probeAuth,
  });
});

export const layer = Layer.effect(ForgejoApi, make);
