import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopForgejoState,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { ForgejoConnectionForm } from "./ForgejoConnectionForm";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type ForgejoBridge = Required<
  Pick<
    DesktopBridge,
    "getForgejoConfiguration" | "saveForgejoConnection" | "removeForgejoConnection"
  >
>;

function LocalForgejoSettings({
  bridge,
  environmentUrl,
}: {
  readonly bridge: ForgejoBridge;
  readonly environmentUrl: string;
}) {
  const [state, setState] = useState<DesktopForgejoState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<DesktopForgejoState["connections"][number] | "new" | null>(
    null,
  );
  const [removing, setRemoving] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { getForgejoConfiguration } = bridge;
  const load = useCallback(() => {
    return getForgejoConfiguration({ environmentUrl })
      .then((result) => {
        setState(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error ? cause.message : "Could not read the Forgejo configuration.",
        );
      });
  }, [getForgejoConfiguration, environmentUrl]);
  useEffect(() => {
    void load();
  }, [load]);

  if (state?.source === "unsupported") return null;
  return (
    <SettingsSection id={searchableSetting("forgejo-connections").id} title="Forgejo connections">
      <div className="space-y-4 px-3 py-3 sm:px-4">
        <p className="text-xs text-muted-foreground">
          Configure the built-in Mac server. Saved connections apply when you quit and reopen T3
          Code.
        </p>
        {error || state?.error ? (
          <div className="space-y-2">
            <p role="alert" className="text-xs text-destructive">
              {error ?? state?.error}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setError(null);
                void load();
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {state === null && error === null ? (
          <p className="text-xs text-muted-foreground">Loading saved connections…</p>
        ) : null}
        {state?.source === "external" ? (
          <p className="text-xs text-muted-foreground">
            Forgejo is configured by T3CODE_FORGEJO_CONNECTIONS in the server environment, including
            when it is an empty list. That configuration takes priority over saved connections.
            Change it outside T3 Code, then quit and reopen the app.
          </p>
        ) : null}
        {state?.source === "local" ? (
          <>
            <p role="status" className="text-xs text-muted-foreground">
              {state.error !== null
                ? "Saved configuration could not be loaded."
                : state.pendingRestart
                  ? "Saved changes are pending. Quit and reopen T3 Code manually to apply them; saving does not interrupt current work."
                  : "Saved configuration matches this launch."}{" "}
              Currently loaded: {state.activeConnectionIds.join(", ") || "none"}. Authentication is
              shown in Source Control Providers; Rescan checks authentication without applying saved
              changes.
            </p>
            {state.connections.length === 0 ? (
              <p className="text-xs text-muted-foreground">No saved Forgejo connections.</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {state.connections.map((connection) => (
                  <li
                    key={connection.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="text-xs font-medium">{connection.id}</p>
                      <p className="break-all text-xs text-muted-foreground">
                        {connection.apiUrl.replace(/\/api\/v1\/?$/u, "")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {connection.hasToken ? "Token saved" : "No token saved"}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={editing !== null || pending}
                        onClick={() => {
                          setError(null);
                          setEditing(connection);
                        }}
                        aria-label={`Edit ${connection.id}`}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={editing !== null || pending}
                        onClick={() => {
                          setError(null);
                          setRemoving(connection.id);
                        }}
                        aria-label={`Remove ${connection.id}`}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {editing === null ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending || state.error !== null}
                onClick={() => {
                  setError(null);
                  setEditing("new");
                }}
              >
                Add Forgejo connection
              </Button>
            ) : (
              <ForgejoConnectionForm
                key={editing === "new" ? "new" : editing.id}
                connection={editing === "new" ? null : editing}
                onCancel={() => setEditing(null)}
                onSave={async (connection) => {
                  const result = await bridge.saveForgejoConnection({ environmentUrl, connection });
                  setState(result);
                  setError(null);
                  setEditing(null);
                }}
              />
            )}
          </>
        ) : null}
      </div>
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Forgejo connection “{removing}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The saved connection and token will be removed from this Mac. The running server keeps
              its current configuration until you quit and reopen T3 Code. This does not revoke the
              token on Forgejo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={pending} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                if (removing === null) return;
                setPending(true);
                void bridge
                  .removeForgejoConnection({ environmentUrl, id: removing })
                  .then((result) => {
                    setState(result);
                    setRemoving(null);
                    setError(null);
                  })
                  .catch((cause: unknown) => {
                    setRemoving(null);
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "Could not remove the Forgejo connection.",
                    );
                  })
                  .finally(() => setPending(false));
              }}
            >
              {pending ? "Removing…" : "Remove connection"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

export function ForgejoConnectionSettings() {
  const { scope, environment } = useSettingsScope();
  const environmentUrl = useEnvironmentHttpBaseUrl(environment?.environmentId ?? null);
  const bridge = window.desktopBridge;
  if (
    scope.kind !== "environment" ||
    scope.environmentIds.length !== 1 ||
    environmentUrl === null ||
    bridge?.getClientPlatform?.() !== "darwin" ||
    !bridge.getForgejoConfiguration ||
    !bridge.saveForgejoConnection ||
    !bridge.removeForgejoConnection
  )
    return null;
  const primary = bridge
    .getLocalEnvironmentBootstraps()
    .find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
  if (!primary?.httpBaseUrl || new URL(primary.httpBaseUrl).href !== new URL(environmentUrl).href)
    return null;
  return (
    <LocalForgejoSettings
      key={environmentUrl}
      environmentUrl={environmentUrl}
      bridge={{
        getForgejoConfiguration: bridge.getForgejoConfiguration,
        saveForgejoConnection: bridge.saveForgejoConnection,
        removeForgejoConnection: bridge.removeForgejoConnection,
      }}
    />
  );
}
