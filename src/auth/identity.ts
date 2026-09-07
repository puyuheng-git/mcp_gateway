export const roleNames = ["viewer", "developer", "operator", "admin"] as const;
export type Role = (typeof roleNames)[number];
export type CapabilityLevel = "L0" | "L1" | "L2" | "L3";

export interface Identity {
  id: string;
  roles: Role[];
  scopes: ReadonlySet<string>;
  maxCapabilityLevel: number;
  credentialId: string;
}

const readScopes = ["server:read", "docker:read", "git:read", "github:read", "blog:read"];
const developmentScopes = [...readScopes, "git:write", "github:write", "blog:write"];

export const roleScopes: Record<Role, readonly string[]> = {
  viewer: readScopes,
  developer: developmentScopes,
  operator: [...developmentScopes, "docker:write"],
  admin: ["*"],
};

export const roleLevels: Record<Role, number> = {
  viewer: 0,
  developer: 1,
  operator: 2,
  admin: 3,
};

export function hasScopes(identity: Identity, requiredScopes: readonly string[]): boolean {
  return identity.scopes.has("*") || requiredScopes.every((scope) => identity.scopes.has(scope));
}
