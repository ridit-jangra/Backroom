/**
 * What `cloudflare:workers` resolves to on Node (see aliases.ts). The worker imports only `DurableObject` from it
 * (apps/worker/src/hub/WorkspaceHub.ts); the runtime behind it is do-runtime.ts.
 */
export { DurableObject } from './do-runtime';
