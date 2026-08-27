export {
  type ClaudeAuthProbeFn,
  runClaudeAuthStatusProbe,
} from '@/modules/claude-profiles/claude-auth-status-probe.js';
export {
  claudeConfigJsonPathFor,
  claudeHomeFor,
  claudeProfilesRoot,
  legacyClaudeHome,
} from '@/modules/claude-profiles/claude-home.resolver.js';
export {
  claudeProfilesService,
  createClaudeProfilesService,
} from '@/modules/claude-profiles/claude-profiles.service.js';
export {
  createClaudeProfilesRouter,
  default as claudeProfilesRoutes,
} from '@/modules/claude-profiles/claude-profiles.routes.js';
