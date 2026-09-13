// Remote access (FT-M08): the optional Remote Gateway listener, browser pairing
// and the server-side remote browser sessions behind it.

// createRemoteAccess: used by the server entrypoint to compose the gateway, guard, routes and socket revocation.
export { createRemoteAccess } from '@/modules/remote-access/remote-access.module.js';
// readRemoteGatewayConfig: used by the server entrypoint to read and validate the gateway configuration once.
export { readRemoteGatewayConfig } from '@/modules/remote-access/remote-gateway-config.js';
// isRemoteTransport: used by the auth module so remote requests only authenticate with a remote browser session.
export { isRemoteTransport } from '@/modules/remote-access/remote-transport.js';
