// Hosted Relay (FT-M11): an always-reachable coordination service for browsers
// and outbound RuntimeNodes that is never itself a RuntimeNode.

// createHostedRelay: used by the relay entrypoint (server/relay.ts) and the relay integration tests.
export { createHostedRelay, hostedRelayProviderRuntime, HOSTED_RELAY_JSON_LIMIT } from '@/modules/hosted-relay/hosted-relay.app.js';
export type { HostedRelay, HostedRelayOptions } from '@/modules/hosted-relay/hosted-relay.app.js';
// Route allowlists: exported for tests that prove which API paths a relay answers.
export { HOSTED_RELAY_PROVIDER_ROUTES, HOSTED_RELAY_USER_ROUTES } from '@/modules/hosted-relay/hosted-relay-routes.js';
