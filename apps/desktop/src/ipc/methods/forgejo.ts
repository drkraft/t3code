import { DesktopForgejoConnectionInput, DesktopForgejoState } from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopForgejoConnections from "../../settings/DesktopForgejoConnections.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

class ForgejoIpcError extends Schema.TaggedError<ForgejoIpcError>()("ForgejoIpcError", {
  message: Schema.String,
}) {}

const isStoreError = Schema.is(DesktopForgejoConnections.DesktopForgejoConnectionsError);
const isIpcError = Schema.is(ForgejoIpcError);

const ensureLocal = Effect.fn("desktop.ipc.forgejo.ensureLocal")(function* (
  environmentUrl: string,
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  const main = yield* (yield* ElectronWindow.ElectronWindow).main;
  if (!event || Option.isNone(main) || main.value.webContents.id !== event.sender.id) {
    return yield* new ForgejoIpcError({ message: "Forgejo request was rejected." });
  }
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const primary = yield* (yield* DesktopBackendPool.DesktopBackendPool).primary;
  const current = yield* primary.currentConfig;
  const url = URL.parse(environmentUrl);
  if (
    environment.platform !== "darwin" ||
    Option.isNone(current) ||
    url === null ||
    url.href !== current.value.httpBaseUrl.href ||
    current.value.bootstrap.t3Home !== environment.baseDir ||
    current.value.bootstrapDelivery !== "fd3" ||
    current.value.runningDistro !== undefined
  ) {
    return yield* new ForgejoIpcError({
      message: "Forgejo settings require the native local Mac environment.",
    });
  }
});

// Schema errors retain the raw input, including credentials. Sanitize the complete
// IPC method, covering both payload decoding and result encoding.
const sanitize = <E, R>(method: DesktopIpc.DesktopIpcMethod<E, R>) => ({
  channel: method.channel,
  handler: (raw: unknown, event?: DesktopIpc.DesktopIpcInvokeEvent) =>
    method
      .handler(raw, event)
      .pipe(
        Effect.mapError((error) =>
          isStoreError(error) || isIpcError(error)
            ? error
            : new ForgejoIpcError({ message: "Invalid Forgejo request or response." }),
        ),
      ),
});

export const getForgejoConfiguration = sanitize(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.GET_FORGEJO_CONFIGURATION_CHANNEL,
    payload: Schema.Struct({ environmentUrl: Schema.String }),
    result: DesktopForgejoState,
    handler: Effect.fn("desktop.ipc.forgejo.get")(function* (input, event) {
      yield* ensureLocal(input.environmentUrl, event);
      return yield* (yield* DesktopForgejoConnections.DesktopForgejoConnections).get;
    }),
  }),
);

export const saveForgejoConnection = sanitize(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.SAVE_FORGEJO_CONNECTION_CHANNEL,
    payload: Schema.Struct({
      environmentUrl: Schema.String,
      connection: DesktopForgejoConnectionInput,
    }),
    result: DesktopForgejoState,
    handler: Effect.fn("desktop.ipc.forgejo.save")(function* (input, event) {
      yield* ensureLocal(input.environmentUrl, event);
      return yield* (yield* DesktopForgejoConnections.DesktopForgejoConnections).upsert(
        input.connection,
      );
    }),
  }),
);

export const removeForgejoConnection = sanitize(
  DesktopIpc.makeIpcMethod({
    channel: IpcChannels.REMOVE_FORGEJO_CONNECTION_CHANNEL,
    payload: Schema.Struct({ environmentUrl: Schema.String, id: Schema.String }),
    result: DesktopForgejoState,
    handler: Effect.fn("desktop.ipc.forgejo.remove")(function* (input, event) {
      yield* ensureLocal(input.environmentUrl, event);
      return yield* (yield* DesktopForgejoConnections.DesktopForgejoConnections).remove(input.id);
    }),
  }),
);
