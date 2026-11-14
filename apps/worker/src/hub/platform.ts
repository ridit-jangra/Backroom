/**
 * The hub's only runtime-specific calls (workerd globals), kept here so another host can swap this one module.
 * The Node server replaces it at build time with apps/server/src/platform/hub-platform.ts; nothing else in the
 * hub knows which runtime it is on.
 */

/** `new WebSocketPair()`: `[client, server]`. */
export function newWebSocketPair(): { 0: WebSocket; 1: WebSocket } {
  return new WebSocketPair();
}

/** The 101 response that hands the pair's client end to the caller. */
export function upgradeResponse(client: WebSocket): Response {
  return new Response(null, { status: 101, webSocket: client });
}

/** The request/response pair for `ctx.setWebSocketAutoResponse`. */
export function autoResponsePair(request: string, response: string): WebSocketRequestResponsePair {
  return new WebSocketRequestResponsePair(request, response);
}
