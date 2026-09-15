import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Contracts from "./index.ts";

const decodeMetadata = Schema.decodeUnknownSync(Contracts.ForgejoConnectionMetadata);
const isMetadata = Schema.is(Contracts.ForgejoConnectionMetadata);
const isMetadataArray = Schema.is(Contracts.ForgejoConnectionMetadataArray);
const decodeBootstrap = Schema.decodeUnknownSync(Contracts.ForgejoBootstrapConnections);
const isBootstrap = Schema.is(Contracts.ForgejoBootstrapConnection);
const isBootstrapArray = Schema.is(Contracts.ForgejoBootstrapConnections);

const primary = {
  id: "primary",
  apiUrl: "https://forge.example/api/v1/",
  gitHosts: ["ForgeSSH", "forge.example:2222"],
};

describe("Forgejo connection contracts", () => {
  it("accepts metadata without a credential reference", () => {
    expect(decodeMetadata(primary)).toEqual(primary);
  });

  it.each([
    { id: "bad id" },
    { apiUrl: "https://forge.example/sub/api/v1" },
    { apiUrl: "https://user:secret@forge.example/api/v1" },
    { apiUrl: "https://forge.example/api/v1?token=secret" },
    { apiUrl: "https://forge.example/api/v1#fragment" },
    { apiUrl: "ftp://forge.example/api/v1" },
    { gitHosts: ["https://forge.example"] },
    { gitHosts: ["user@forge.example"] },
    { wipPrefixes: ["  "] },
  ])("rejects invalid metadata (%#)", (override) => {
    expect(isMetadata({ ...primary, ...override })).toBe(false);
  });

  it.each([
    { ...primary, apiUrl: "https://other.example/api/v1", gitHosts: [] },
    { ...primary, id: "other", apiUrl: "https://FORGE.example:443/api/v1", gitHosts: [] },
    { ...primary, id: "other", apiUrl: "https://other.example/api/v1", gitHosts: ["FORGESSH"] },
  ])("rejects duplicate ids and normalized authorities (%#)", (other) => {
    expect(isMetadataArray([primary, other])).toBe(false);
  });

  it("allows repeated aliases within one connection and distinct explicit ports", () => {
    const connections = [
      { ...primary, gitHosts: ["forge.example", "FORGE.example"] },
      { id: "local", apiUrl: "http://localhost:3000/api/v1", gitHosts: ["forge.example:2222"] },
    ];
    expect(isMetadataArray(connections)).toBe(true);
  });

  it("carries a bootstrap token without requiring tokenEnv", () => {
    const connection = { ...primary, token: "" };
    expect(decodeBootstrap([connection])).toEqual([connection]);
  });

  it("rejects bootstrap connections without a token", () => {
    expect(isBootstrap(primary)).toBe(false);
  });

  it("applies authority conflict validation to bootstrap connections", () => {
    expect(
      isBootstrapArray([
        { ...primary, token: "first" },
        { ...primary, id: "other", token: "second" },
      ]),
    ).toBe(false);
  });

  it.each([
    ["FORGE.example:2222", "forge.example:2222"],
    ["[::1]:2222", "[::1]:2222"],
    ["https://forge.example", null],
    ["user@forge.example", null],
    ["forge.example/path", null],
  ])("normalizes bare Git authorities (%#)", (input, expected) => {
    expect(Contracts.normalizeForgejoAuthority(input ?? "")).toBe(expected);
  });
});
