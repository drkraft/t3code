import type { DesktopForgejoConnectionInput, DesktopForgejoState } from "@t3tools/contracts";
import { useId, useState } from "react";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

type Connection = DesktopForgejoState["connections"][number];

export function ForgejoConnectionForm({
  connection,
  onSave,
  onCancel,
}: {
  readonly connection: Connection | null;
  readonly onSave: (input: DesktopForgejoConnectionInput) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const formId = useId();
  const [id, setId] = useState(connection?.id ?? "");
  const [instanceUrl, setInstanceUrl] = useState(
    connection?.apiUrl.replace(/\/api\/v1\/?$/u, "") ?? "",
  );
  const [token, setToken] = useState("");
  const [gitHosts, setGitHosts] = useState(connection?.gitHosts.join("\n") ?? "");
  const [configurePrefixes, setConfigurePrefixes] = useState(connection?.wipPrefixes !== undefined);
  const [wipPrefixes, setWipPrefixes] = useState(connection?.wipPrefixes?.join("\n") ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const url = URL.parse(instanceUrl.trim());
        if (
          !url ||
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== "/"
        ) {
          setError(
            "Enter an instance root URL, such as https://forge.example, without a path or credentials.",
          );
          return;
        }
        setPending(true);
        setError(null);
        void onSave({
          id: id.trim(),
          apiUrl: `${url.origin}/api/v1`,
          gitHosts: gitHosts
            .split(/[,\n]/u)
            .map((host) => host.trim())
            .filter(Boolean),
          ...(configurePrefixes
            ? { wipPrefixes: wipPrefixes.split("\n").filter((prefix) => prefix.trim().length > 0) }
            : {}),
          ...(token.length > 0 ? { token } : {}),
        })
          .then(() => setToken(""))
          .catch((cause: unknown) => {
            setError(
              cause instanceof Error ? cause.message : "Could not save the Forgejo connection.",
            );
          })
          .finally(() => setPending(false));
      }}
    >
      <fieldset disabled={pending} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor={`${formId}-id`} className="text-xs font-medium">
            Connection ID
          </label>
          <Input
            id={`${formId}-id`}
            value={id}
            onChange={(event) => setId(event.target.value)}
            required
            pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
            disabled={connection !== null}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            A unique name using letters, numbers, dots, underscores or hyphens. Cannot be changed
            later.
          </p>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${formId}-url`} className="text-xs font-medium">
            Instance URL
          </label>
          <Input
            id={`${formId}-url`}
            type="url"
            value={instanceUrl}
            onChange={(event) => setInstanceUrl(event.target.value)}
            required
            placeholder="https://forge.example"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${formId}-token`} className="text-xs font-medium">
            {connection?.hasToken ? "Replace API token" : "API token"}
          </label>
          <Input
            id={`${formId}-token`}
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            required={!connection?.hasToken}
            autoComplete="new-password"
            aria-describedby={`${formId}-token-help`}
          />
          <p id={`${formId}-token-help`} className="text-xs text-muted-foreground">
            {connection?.hasToken
              ? "Leave blank to keep the saved token. Changing the instance host requires a new token. "
              : ""}
            Encrypted with macOS native storage. Git clone and push credentials are configured
            separately.
          </p>
        </div>
        <details className="space-y-3">
          <summary className="cursor-pointer text-xs font-medium">Advanced options</summary>
          <div className="space-y-1">
            <label htmlFor={`${formId}-hosts`} className="text-xs font-medium">
              Additional Git hosts or SSH aliases
            </label>
            <Textarea
              id={`${formId}-hosts`}
              value={gitHosts}
              onChange={(event) => setGitHosts(event.target.value)}
              placeholder="git.example:2222, work-git"
            />
            <p className="text-xs text-muted-foreground">
              Separate with commas or new lines. The API host is included automatically. Each
              authority must belong to only one connection.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs font-medium">
            <Checkbox checked={configurePrefixes} onCheckedChange={setConfigurePrefixes} />{" "}
            Configure instance WIP prefixes
          </label>
          {configurePrefixes ? (
            <div className="space-y-1">
              <label htmlFor={`${formId}-prefixes`} className="text-xs font-medium">
                WIP prefixes (one per line)
              </label>
              <Textarea
                id={`${formId}-prefixes`}
                value={wipPrefixes}
                onChange={(event) => setWipPrefixes(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Use the instance administrator’s exact values. Empty means the instance has no
                prefixes. Unchecked means unknown; draft transitions remain unavailable.
              </p>
            </div>
          ) : null}
        </details>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save connection"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setToken("");
              onCancel();
            }}
          >
            Cancel
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
