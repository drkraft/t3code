import { assert, describe, it } from "@effect/vitest";
import { reactions, threadIdentity } from "./forgejoActivityJson.ts";

describe("Forgejo activity mapping", () => {
  it("groups supported reactions without counting duplicated page rows", () => {
    const user = { id: 1, login: "viewer" };
    assert.deepEqual(
      reactions(
        [
          { content: "+1", user },
          { content: "+1", user },
          { content: "+1", user: { id: 2, login: "alice" } },
          { content: "custom", user },
        ],
        "viewer",
      ),
      [{ content: "thumbs-up", count: 2, actors: ["alice"], viewerHasReacted: true }],
    );
  });
  it("keeps identical lines in separate reviews and commits distinct", () => {
    const ref = { host: "forge.example", repository: "owner/repo", number: 3 };
    const comment = {
      pull_request_review_id: 4,
      path: "a.ts",
      position: 0,
      original_position: 7,
      commit_id: "abc",
    };
    const id = threadIdentity(ref, comment);
    assert.notEqual(id, threadIdentity(ref, { ...comment, pull_request_review_id: 5 }));
    assert.notEqual(id, threadIdentity(ref, { ...comment, commit_id: "def" }));
    assert.notEqual(id, threadIdentity({ ...ref, host: "second.example" }, comment));
    assert.include(decodeURIComponent(id), '"line":-7');
  });
});

it("retains reaction counts when the user was deleted", () => {
  assert.deepEqual(reactions([{ content: "heart", user: null }], "viewer"), [
    { content: "heart", count: 1, actors: [], viewerHasReacted: false },
  ]);
});
