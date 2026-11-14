/**
 * Node replacement for apps/worker/src/hub/platform.ts (swapped in by the build and test resolvers, see
 * aliases.ts). The pair and its upgrade response belong to the upgrade the bridge is serving (ws-bridge.ts).
 */
import type * as WorkerPlatform from '../../../worker/src/hub/platform';
import { pairForCurrentUpgrade, responseForCurrentUpgrade } from './ws-bridge';

export function newWebSocketPair(): { 0: WebSocket; 1: WebSocket } {
  return pairForCurrentUpgrade();
}

export function upgradeResponse(client: WebSocket): Response {
  return responseForCurrentUpgrade(client);
}

export function autoResponsePair(request: string, response: string): WebSocketRequestResponsePair {
  return { request, response } as WebSocketRequestResponsePair;
}

// Compile-time check: this module offers exactly what the one it replaces does.
void ({ newWebSocketPair, upgradeResponse, autoResponsePair } satisfies typeof WorkerPlatform);
