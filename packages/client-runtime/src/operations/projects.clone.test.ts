import { describe, expect, it } from "vite-plus/test";
import { getDefaultCloneUrl } from "./projects.ts";

describe("Forgejo clone transport", () => {
  const repository = {
    provider: "forgejo" as const,
    url: "https://forge.example/team/project.git",
    sshUrl: "ssh://git@git.example:2222/team/project.git",
  };

  it.each([
    "https://forge.example/team/project",
    "http://forge.example/team/project.git",
    "  HTTPS://forge.example/team/project  ",
  ])("uses the server HTTP clone URL for the entered URL %s", (input) => {
    expect(getDefaultCloneUrl(repository, input)).toBe(repository.url);
  });

  it.each([
    "ssh://git@git.example:2222/team/project.git",
    "git@git.example:team/project.git",
    "team/project",
    undefined,
  ])("retains SSH for %s", (input) => {
    expect(getDefaultCloneUrl(repository, input)).toBe(repository.sshUrl);
  });

  it("preserves other providers' transport defaults", () => {
    expect(getDefaultCloneUrl({ ...repository, provider: "gitlab" }, repository.url)).toBe(
      repository.sshUrl,
    );
    expect(getDefaultCloneUrl({ ...repository, provider: "github" }, repository.sshUrl)).toBe(
      repository.url,
    );
  });
});
