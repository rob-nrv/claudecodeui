// Imported by server/relay.ts right after load-env and before any module that
// may open the database or read the role while it is being evaluated.
import { setServerRole } from '@/shared/utils.js';

setServerRole('hosted-relay');
