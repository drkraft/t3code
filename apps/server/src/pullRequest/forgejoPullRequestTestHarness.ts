import { ConfigProvider, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Api from "../sourceControl/ForgejoApi.ts";

export const harness = (respond: (url: URL) => Response) =>
  Api.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, respond(new URL(request.url)))),
        ),
      ),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_FORGEJO_CONNECTIONS:
              '[{"id":"test","apiUrl":"https://forge.example/api/v1","gitHosts":[],"tokenEnv":"TEST_TOKEN"}]',
            TEST_TOKEN: "fixture-token",
          },
        }),
      ),
    ),
  );

export const pullRequestFixture = {
  number: 1,
  title: "Change",
  html_url: "https://forge.example/team/repo/pulls/1",
  user: { id: 3, login: "alice" },
  body: "Description",
  state: "open",
  merged: false,
  draft: false,
  mergeable: true,
  merge_base: "base-sha",
  head: { ref: "feature", sha: "new-head", repo: { full_name: "alice/repo" } },
  base: { ref: "main", sha: "base-tip", repo: { full_name: "team/repo" } },
  additions: 8,
  deletions: 2,
  changed_files: 1,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-12T00:00:00Z",
  closed_at: null,
  merged_at: null,
  requested_reviewers: [{ id: 4, login: "bob" }],
  labels: [{ name: "bug", color: "ff0000" }],
};
