import { createHash, timingSafeEqual } from "node:crypto";
import type { GatewayConfig } from "../config/config.js";
import { type Environment, readSecret } from "../config/secrets.js";
import { GatewayError } from "../errors.js";
import { type Identity, roleLevels, roleScopes } from "./identity.js";

export class Authenticator {
  private readonly credentials: { digest: Buffer; identity: Identity }[];

  constructor(config: GatewayConfig["auth"], env: Environment = process.env) {
    this.credentials = config.identities.map((entry) => {
      const digest = createHash("sha256").update(readSecret(entry.tokenEnv, env)).digest();
      return {
        digest,
        identity: {
          id: entry.id,
          roles: [...entry.roles],
          scopes: new Set([...entry.roles.flatMap((role) => roleScopes[role]), ...entry.scopes]),
          maxCapabilityLevel: Math.max(...entry.roles.map((role) => roleLevels[role])),
          credentialId: digest.toString("hex"),
        },
      };
    });
  }

  authenticate(header: string | string[] | undefined): Identity {
    const match = typeof header === "string" ? /^Bearer ([^\s]+)$/i.exec(header) : null;
    const digest = createHash("sha256")
      .update(match?.[1] ?? "")
      .digest();
    let identity: Identity | undefined;
    for (const credential of this.credentials) {
      if (timingSafeEqual(digest, credential.digest) && match) identity = credential.identity;
    }
    if (!identity) throw new GatewayError("AUTHENTICATION_FAILED", "Invalid bearer token", 401);
    return identity;
  }
}
