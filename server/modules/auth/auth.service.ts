import { AppError } from '@/shared/utils.js';

type AuthUser = {
  id: number | bigint;
  username: string;
};

type AuthLoginUser = AuthUser & { password_hash: string };

/** Longest human display name accepted, mirroring Claude profile names. */
const MAX_DISPLAY_NAME_LENGTH = 60;

type AuthDependencies = {
  users: {
    hasUsers(): boolean;
    createUser(username: string, passwordHash: string): AuthUser;
    getUserByUsername(username: string): AuthLoginUser | undefined;
    updateLastLogin(userId: number): void;
    updateDisplayName(userId: number, displayName: string | null): void;
  };
  transaction: {
    begin(): void;
    commit(): void;
    rollback(): void;
  };
  hashPassword(password: string): Promise<string>;
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  generateToken(user: AuthUser): string;
};

function numericUserId(userId: number | bigint): number {
  return Number(userId);
}

/**
 * Normalises the authenticated user row into the shape the frontend consumes.
 *
 * The raw row is passed through unchanged (existing consumers read
 * `username` and friends); `displayName` is added as the single camelCase
 * field the identity layer reads, so no caller has to know that the column
 * is `display_name`.
 */
function withDisplayName(user: unknown): unknown {
  if (typeof user !== 'object' || user === null) {
    return user;
  }

  const row = user as { display_name?: unknown; displayName?: unknown };
  const configured = typeof row.display_name === 'string' ? row.display_name.trim() : '';

  return { ...row, displayName: configured || null };
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * Creates the Auth application service around explicit persistence, crypto,
 * transaction, and token dependencies.
 */
export function createAuthService(dependencies: AuthDependencies) {
  return {
    getStatus() {
      return {
        needsSetup: !dependencies.users.hasUsers(),
        isAuthenticated: false,
      };
    },

    async register(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';

      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }
      if (username.length < 3 || password.length < 6) {
        throw new AppError(
          'Username must be at least 3 characters, password at least 6 characters',
          { code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400 },
        );
      }

      dependencies.transaction.begin();
      try {
        if (dependencies.users.hasUsers()) {
          throw new AppError('User already exists. This is a single-user system.', {
            code: 'AUTH_USER_ALREADY_CONFIGURED',
            statusCode: 403,
          });
        }

        const passwordHash = await dependencies.hashPassword(password);
        const user = dependencies.users.createUser(username, passwordHash);
        const token = dependencies.generateToken(user);
        dependencies.transaction.commit();
        dependencies.users.updateLastLogin(numericUserId(user.id));

        return {
          success: true,
          user: { id: user.id, username: user.username },
          token,
        };
      } catch (error) {
        dependencies.transaction.rollback();
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    async login(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      const user = dependencies.users.getUserByUsername(username);
      const validPassword = user
        ? await dependencies.comparePassword(password, user.password_hash)
        : false;
      if (!user || !validPassword) {
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      dependencies.users.updateLastLogin(numericUserId(user.id));
      return {
        success: true,
        user: { id: user.id, username: user.username },
        token: dependencies.generateToken(user),
      };
    },

    getCurrentUser(user: unknown) {
      return { user: withDisplayName(user) };
    },

    /**
     * Updates the app user's display name.
     *
     * Presentational only — it never touches credentials or the login
     * identity. An empty value clears the override so the UI falls back to
     * the registered username rather than to any hardcoded name.
     */
    updateProfile(user: unknown, displayNameInput: unknown) {
      if (
        typeof user !== 'object'
        || user === null
        || !('id' in user)
        || (typeof user.id !== 'number' && typeof user.id !== 'bigint')
      ) {
        throw new AppError('Authenticated user is required', {
          code: 'AUTH_USER_REQUIRED',
          statusCode: 401,
        });
      }

      if (displayNameInput !== null && typeof displayNameInput !== 'string') {
        throw new AppError('displayName must be a string or null.', {
          code: 'AUTH_DISPLAY_NAME_INVALID',
          statusCode: 400,
        });
      }

      const trimmed = typeof displayNameInput === 'string' ? displayNameInput.trim() : '';
      if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
        throw new AppError(
          `displayName must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`,
          { code: 'AUTH_DISPLAY_NAME_TOO_LONG', statusCode: 400 },
        );
      }

      const displayName = trimmed || null;
      dependencies.users.updateDisplayName(numericUserId(user.id), displayName);

      return { success: true, user: { ...(user as object), displayName } };
    },

    refreshSession(user: unknown) {
      if (
        typeof user !== 'object'
        || user === null
        || !('id' in user)
        || !('username' in user)
        || (typeof user.id !== 'number' && typeof user.id !== 'bigint')
        || typeof user.username !== 'string'
      ) {
        throw new AppError('Authenticated user is required', {
          code: 'AUTH_USER_REQUIRED',
          statusCode: 401,
        });
      }

      return { token: dependencies.generateToken(user as AuthUser) };
    },

    logout() {
      return { success: true, message: 'Logged out successfully' };
    },
  };
}
