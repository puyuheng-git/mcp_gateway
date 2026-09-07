import { authorize } from "../auth/authorization.js";
import type { Identity } from "../auth/identity.js";
import type { GatewayConfig, ToolPolicy } from "../config/config.js";
import { GatewayError } from "../errors.js";

export class PolicyEngine {
  constructor(private readonly config: GatewayConfig["policy"]) {}

  check(identity: Identity, policy: ToolPolicy): void {
    authorize(identity, policy);
    if (!policy.enabled) throw new GatewayError("POLICY_DENIED", "This tool is disabled", 403);
    if (policy.capabilityLevel === "L3" && !this.config.allowProduction) {
      throw new GatewayError("POLICY_DENIED", "Production tools are disabled", 403);
    }
  }

  allows(identity: Identity, policy: ToolPolicy): boolean {
    try {
      this.check(identity, policy);
      return true;
    } catch {
      return false;
    }
  }
}
