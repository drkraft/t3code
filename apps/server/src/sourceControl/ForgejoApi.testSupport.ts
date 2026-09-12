import { vi } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { layer as forgejoLayer } from "./ForgejoApi.ts";
import { ForgejoConnections } from "./ForgejoConnections.ts";

const connections = [
  {
    id: "one",
    apiUrl: "https://forge.example/api/v1",
    gitHosts: ["git.example:2222"],
    tokenEnv: "ONE_TOKEN",
  },
  { id: "two", apiUrl: "https://other.example/api/v1", gitHosts: [], tokenEnv: "TWO_TOKEN" },
];

export function harness(
  response: (request: HttpClientRequest.HttpClientRequest) => Response,
  env: Record<string, string> = { ONE_TOKEN: "first-secret", TWO_TOKEN: "second-secret" },
) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, response(request))),
  );
  const layer = forgejoLayer.pipe(
    Layer.provide(ForgejoConnections.layer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_FORGEJO_CONNECTIONS: JSON.stringify(connections),
            ...env,
          },
        }),
      ),
    ),
  );
  return { execute, layer };
}
