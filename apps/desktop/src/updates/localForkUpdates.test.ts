import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

it.effect("never checks an update feed from a local Forgejo build", () => {
  const harness = makeHarness({ appVersion: "0.0.40-forgejo-local.20260913.g84c983b8b" });
  return Effect.scoped(
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      const state = yield* updates.getState;
      assert.isFalse(state.enabled);
      assert.equal(state.status, "disabled");
      yield* updates.check("manual");
      assert.equal(harness.checkCount(), 0);
    }),
  ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
});
