// Which listener a request arrived on. The mark is set by the gateway server
// itself, before any application code runs, on the request object: a client
// cannot set it with a header, a query parameter or a cookie.
const remoteRequests = new WeakSet<object>();
const remoteSessionIds = new WeakMap<object, string>();

/** Marks a request as received by the Remote Gateway listener. Called only by the gateway server. */
export function markRemoteTransport(request: object): void {
  remoteRequests.add(request);
}

/**
 * True when the request came through the Remote Gateway. Used by the auth
 * module (remote requests authenticate only with a remote browser session)
 * and by the websocket gateway.
 */
export function isRemoteTransport(request: object | null | undefined): boolean {
  return Boolean(request) && remoteRequests.has(request as object);
}

/** Records which remote browser session authenticated this request (never the cookie value). */
export function setRemoteSessionId(request: object, sessionId: string): void {
  remoteSessionIds.set(request, sessionId);
}

export function readRemoteSessionId(request: object | null | undefined): string | null {
  return request ? remoteSessionIds.get(request) ?? null : null;
}
