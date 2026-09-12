import { assert, it } from "@effect/vitest";
import { Schema } from "effect";
import { PullRequest, toChangeRequest } from "./forgejoPullRequestJson.ts";

import { pullRequestFixture } from "./forgejoPullRequestTestHarness.ts";
const decode = Schema.decodeUnknownSync(PullRequest);
it("distinguishes closed and merged pull requests while preserving fork identity and counts", () => {
  const row = toChangeRequest(decode({ ...pullRequestFixture, state: "closed", merged: true }));
  assert.strictEqual(row.state, "merged");
  assert.strictEqual(row.headRepositoryNameWithOwner, "alice/repo");
  assert.strictEqual(row.additions, 8);
  assert.strictEqual(
    toChangeRequest(decode({ ...pullRequestFixture, state: "closed" })).state,
    "closed",
  );
});
it("retains draft truth from the server and tolerates deleted authors and null arrays", () => {
  const row = toChangeRequest(
    decode({
      ...pullRequestFixture,
      title: "plain",
      draft: true,
      user: null,
      labels: null,
      requested_reviewers: null,
    }),
  );
  assert.strictEqual(row.isDraft, true);
  assert.strictEqual(row.author, null);
  assert.deepStrictEqual(row.labels, []);
});
