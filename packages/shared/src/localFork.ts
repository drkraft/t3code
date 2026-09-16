export const LOCAL_FORK_APP_ID = "com.drkraft.t3code.forgejo";
export const LOCAL_FORK_PRODUCT_NAME = "T3 Code (Forgejo)";

export function isLocalForkVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-forgejo-local\.\d+\.g[0-9a-f]{7,40}$/u.test(version);
}
