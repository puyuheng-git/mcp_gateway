import type { ToolPolicy } from "../config/config.js";
import { GatewayError } from "../errors.js";
import { hasScopes, type Identity } from "./identity.js";

export function authorize(identity: Identity, policy: ToolPolicy): void {
  const level = Number(policy.capabilityLevel.slice(1));
  if (!hasScopes(identity, policy.requiredScopes) || level > identity.maxCapabilityLevel) {
    throw new GatewayError("AUTHORIZATION_DENIED", "You are not permitted to use this tool", 403);
  }
}
