export type ClaudeProfileConnectionState = 'connected' | 'expired' | 'not_authenticated' | 'unknown';

export type ClaudeProfileVerifiedIdentity = {
  value: string;
  method: 'cli_probe' | 'credentials_file' | 'none';
  tier: string | null;
  verifiedAt: number;
};

export type ClaudeProfile = {
  id: string;
  displayName: string;
  connectionState: ClaudeProfileConnectionState;
  verifiedIdentity: ClaudeProfileVerifiedIdentity | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};
