export { initializeDatabase } from '@/modules/database/init-db.js';
export { closeConnection, getConnection, getDatabasePath } from '@/modules/database/connection.js';
export { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
export { appConfigDb } from '@/modules/database/repositories/app-config.js';
// claudeProfilesDb: used by the claude-profiles module to persist multi-account Claude profile rows.
export { claudeProfilesDb } from '@/modules/database/repositories/claude-profiles.db.js';
export type { ClaudeProfileRecord } from '@/modules/database/repositories/claude-profiles.db.js';
export { credentialsDb } from '@/modules/database/repositories/credentials.js';
export { githubTokensDb } from '@/modules/database/repositories/github-tokens.js';
export { notificationChannelEndpointsDb } from '@/modules/database/repositories/notification-channel-endpoints.js';
export { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';
// providerModelsDb: used by Providers to persist user-managed custom model rows.
export { providerModelsDb } from '@/modules/database/repositories/provider-models.js';
// projectsDb: used by Projects, Worktrees, Git, WebSocket, and notification modules to persist and resolve project records.
export { projectsDb } from '@/modules/database/repositories/projects.db.js';
export type { ProjectRegistryRow } from '@/modules/database/repositories/projects.db.js';
export { pushSubscriptionsDb } from '@/modules/database/repositories/push-subscriptions.js';
// queuedMessagesDb: server-side single-slot "send after this run finishes" queue (FT-M03).
export { queuedMessagesDb } from '@/modules/database/repositories/queued-messages.db.js';
export type { QueuedMessageRow } from '@/modules/database/repositories/queued-messages.db.js';
// remoteAccessDb: used by the remote-access module for pairing codes and remote browser sessions (FT-M08).
export { remoteAccessDb } from '@/modules/database/repositories/remote-access.db.js';
export type { RemoteBrowserSessionRecord } from '@/modules/database/repositories/remote-access.db.js';
// runtimeNodesDb: used by the runtime-nodes module to persist RuntimeNode identity and last probe results (FT-M07).
export { runtimeNodesDb } from '@/modules/database/repositories/runtime-nodes.db.js';
export type { RuntimeNodeRecord } from '@/modules/database/repositories/runtime-nodes.db.js';
// runtimeNodeCredentialsDb / runtimeNodeEnrollmentsDb / runtimeNodeWorkspacesDb: used by the
// runtime-nodes module for remote node credentials, one-time enrollment and workspace mappings (FT-M08).
export { runtimeNodeCredentialsDb } from '@/modules/database/repositories/runtime-node-credentials.db.js';
export type { RuntimeNodeCredentialRecord } from '@/modules/database/repositories/runtime-node-credentials.db.js';
export { runtimeNodeEnrollmentsDb } from '@/modules/database/repositories/runtime-node-enrollments.db.js';
export type { EnrollmentRedemption } from '@/modules/database/repositories/runtime-node-enrollments.db.js';
export { runtimeNodeWorkspacesDb } from '@/modules/database/repositories/runtime-node-workspaces.db.js';
export type { RuntimeNodeWorkspaceRecord } from '@/modules/database/repositories/runtime-node-workspaces.db.js';
export { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';
// sessionHandoffsDb: used by Providers to persist FT-M05 Task handoff lineage (source run -> new target run).
export { sessionHandoffsDb } from '@/modules/database/repositories/session-handoffs.db.js';
export type { SessionHandoffRow } from '@/modules/database/repositories/session-handoffs.db.js';
export { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
export { userDb } from '@/modules/database/repositories/users.js';
export { vapidKeysDb } from '@/modules/database/repositories/vapid-keys.js';
