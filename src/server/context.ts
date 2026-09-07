import { AsyncLocalStorage } from "node:async_hooks";
import type { Identity } from "../auth/identity.js";

export const requestContext = new AsyncLocalStorage<{ requestId: string; identity: Identity }>();
