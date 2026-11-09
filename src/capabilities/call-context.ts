import { AsyncLocalStorage } from "node:async_hooks";

export interface GatewayActor {
  id: string;
  moderate: boolean;
}

export const gatewayActorMetaKey = "gateway/actor";
export const gatewayModerateMetaKey = "gateway/moderate";

const actorPattern = /^[A-Za-z0-9_-]{1,64}$/;

export const gatewayCallActor = new AsyncLocalStorage<GatewayActor>();

export function readGatewayActor(meta: unknown): GatewayActor | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const record = meta as Record<string, unknown>;
  const id = record[gatewayActorMetaKey];
  if (typeof id !== "string" || !actorPattern.test(id)) return undefined;
  return { id, moderate: record[gatewayModerateMetaKey] === true };
}
