import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsRegistry from "../vcs/VcsDriverRegistry.ts";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as ForgejoApi from "./ForgejoApi.ts";

export const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const context = {
  provider: { kind: "forgejo" as const, name: "Forgejo", baseUrl: "https://forge.example" },
  remoteName: "origin",
  remoteUrl: "ssh://git@git.example:2222/team/project.git",
};
export const repository = {
  id: 1,
  full_name: "team/project",
  clone_url: "https://forge.example/team/project.git",
  ssh_url: "ssh://git@git.example:2222/team/project.git",
  default_branch: "develop",
  empty: false,
};
export const fork = {
  ...repository,
  id: 2,
  full_name: "alice/renamed",
  clone_url: "https://forge.example/alice/renamed.git",
  ssh_url: "ssh://git@git.example:2222/alice/renamed.git",
  parent: { id: 1, full_name: "team/project" },
};
export const pullRequest = {
  number: 42,
  title: "Improve feature",
  html_url: "https://forge.example/team/project/pulls/42",
  state: "open",
  merged: false,
  draft: false,
  updated_at: "2026-09-12T12:00:00Z",
  base: { ref: "develop", sha: "123", repo: repository },
  head: { ref: "feature", sha: "abc", repo: fork },
};
export function apiHarness(
  response: (request: HttpClientRequest.HttpClientRequest) => Response,
  multiple = false,
) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const connections = [
    {
      id: "one",
      apiUrl: "https://forge.example/api/v1",
      gitHosts: ["git.example:2222"],
      tokenEnv: "TOKEN",
    },
    ...(multiple
      ? [{ id: "two", apiUrl: "https://other.example/api/v1", gitHosts: [], tokenEnv: "TOKEN" }]
      : []),
  ];
  const config = ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: { T3CODE_FORGEJO_CONNECTIONS: encode(connections), TOKEN: "test" },
    }),
  );
  const layer = ForgejoApi.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request);
          return Effect.succeed(HttpClientResponse.fromWeb(request, response(request)));
        }),
      ),
    ),
    Layer.provideMerge(config),
  );
  return { layer, requests };
}
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
export const requestBody = (request: HttpClientRequest.HttpClientRequest | undefined) => {
  if (request?.body._tag !== "Uint8Array") return undefined;
  return decodeJson(new TextDecoder().decode(request.body.body));
};

export function harness(
  response: (request: HttpClientRequest.HttpClientRequest) => Response,
  multiple = false,
) {
  const api = apiHarness(response, multiple);
  return {
    requests: api.requests,
    layer: api.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Layer.mock(Git.GitVcsDriver)({})),
      Layer.provideMerge(
        Layer.mock(VcsRegistry.VcsDriverRegistry)({ detect: () => Effect.succeed(null) }),
      ),
    ),
  };
}
