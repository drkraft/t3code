import * as Schema from "effect/Schema";
import { ForgejoConnectionMetadata } from "./forgejoConnections.ts";

export const DesktopForgejoConnectionInput = Schema.Struct({
  ...ForgejoConnectionMetadata.fields,
  token: Schema.optionalKey(Schema.String.check(Schema.isPattern(/\S/u))),
});
export type DesktopForgejoConnectionInput = typeof DesktopForgejoConnectionInput.Type;

export const DesktopForgejoState = Schema.Struct({
  source: Schema.Literals(["local", "external", "unsupported"]),
  connections: Schema.Array(
    Schema.Struct({
      ...ForgejoConnectionMetadata.fields,
      hasToken: Schema.Boolean,
    }),
  ),
  pendingRestart: Schema.Boolean,
  activeConnectionIds: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type DesktopForgejoState = typeof DesktopForgejoState.Type;
