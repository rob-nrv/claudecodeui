/**
 * Framework-free presentation rules for Settings > Remote access (FT-M08).
 * Everything shown comes from the server; nothing is inferred from the
 * browser's own location except the fallback control plane origin.
 */

export type RemoteGatewayStatus = {
  mode: 'off' | 'tls' | 'external-tls' | 'invalid';
  state: 'disabled' | 'starting' | 'listening' | 'failed';
  publicOrigin: string | null;
  bindHost: string | null;
  port: number | null;
  error: string | null;
};

export type RemoteBrowserSession = {
  sessionId: string;
  label: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
};

export type RemoteAccessStatus = {
  transport: 'local' | 'remote';
  gateway: RemoteGatewayStatus;
  localListener: { host: string; port: number; loopbackOnly: boolean };
  sessions: RemoteBrowserSession[];
};

export type StatusDisplay = { key: string; emphasis: 'positive' | 'warning' | 'muted' };

export function describeGateway(gateway: RemoteGatewayStatus): StatusDisplay {
  switch (gateway.state) {
    case 'listening':
      return { key: 'listening', emphasis: 'positive' };
    case 'failed':
      return { key: 'failed', emphasis: 'warning' };
    case 'starting':
      return { key: 'starting', emphasis: 'muted' };
    default:
      return { key: 'off', emphasis: 'muted' };
  }
}

/** The app port must stay on loopback; anything else is reachable without the gateway's TLS and pairing. */
export function describeLocalListener(listener: RemoteAccessStatus['localListener']): StatusDisplay {
  return listener.loopbackOnly ? { key: 'loopbackOnly', emphasis: 'positive' } : { key: 'exposed', emphasis: 'warning' };
}

/**
 * The origin a node agent should enroll against: the gateway when it listens,
 * otherwise this page's own origin (only usable by a node on the same machine,
 * since node agents refuse plain http to other hosts).
 */
export function resolveEnrollmentOrigin(gateway: RemoteGatewayStatus | null, pageOrigin: string): string {
  return gateway?.state === 'listening' && gateway.publicOrigin ? gateway.publicOrigin : pageOrigin;
}

export function buildNodeAgentCommands(serverOrigin: string, code: string): string[] {
  return [
    `cloudcli node enroll --server ${serverOrigin} --code ${code}`,
    'cloudcli node start --workspace-root <folder containing your projects>',
  ];
}
