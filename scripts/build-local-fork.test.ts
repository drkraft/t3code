import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createBuildConfig, resolveDesktopProductName } from "./build-desktop-artifact.ts";

const version = "0.0.40-forgejo-local.20260913.g84c983b8b";

it.effect("packages the local fork separately without an upstream update feed", () =>
  Effect.gen(function* () {
    const config = yield* createBuildConfig(
      "mac",
      "zip",
      version,
      false,
      false,
      undefined,
      undefined,
    );
    assert.equal(config.appId, "com.drkraft.t3code.forgejo");
    assert.equal(config.productName, "T3 Code (Forgejo)");
    assert.isNull(config.publish);
    assert.include(config.mac, { identity: "-" });
    assert.equal(resolveDesktopProductName(version), "T3 Code (Forgejo)");
  }).pipe(
    Effect.provide([
      NodeServices.layer,
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: { GITHUB_REPOSITORY: "pingdotgg/t3code" },
        }),
      ),
    ]),
  ),
);

it.effect("uses an explicit local signing identity without enabling release signing", () =>
  Effect.gen(function* () {
    const config = yield* createBuildConfig(
      "mac",
      "zip",
      version,
      false,
      false,
      undefined,
      undefined,
    );
    assert.include(config.mac, { identity: "T3 Code Forgejo Local", notarize: false });
    assert.notProperty(config.mac, "sign");
    assert.notProperty(config.mac, "provisioningProfile");
    assert.equal(config.appId, "com.drkraft.t3code.forgejo");
    assert.isNull(config.publish);
    const release = yield* createBuildConfig(
      "mac",
      "zip",
      "0.0.40",
      false,
      false,
      undefined,
      undefined,
    );
    assert.notProperty(release.mac, "identity");
  }).pipe(
    Effect.provide([
      NodeServices.layer,
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_LOCAL_MAC_SIGNING_IDENTITY: "T3 Code Forgejo Local",
          },
        }),
      ),
    ]),
  ),
);
