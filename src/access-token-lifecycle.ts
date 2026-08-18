import {
  GoogleRefreshTokenRevokedError,
  GSC_ACCESS_REVOKED_MESSAGE,
  refreshAccessToken,
} from './google';
import {
  deleteUser,
  getDecryptedRefreshToken,
} from './storage';

export interface GoogleAccessTokenEnv {
  USER_KV: KVNamespace;
  TOKEN_ENCRYPTION_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

export interface GoogleAccessTokenProvider {
  getAccessToken(googleId: string): Promise<string>;
}

interface AccessTokenCacheEntry {
  token: string;
  expires_at: number;
}

export interface AccessTokenLifecycleDependencies {
  getDecryptedRefreshToken: typeof getDecryptedRefreshToken;
  refreshAccessToken: typeof refreshAccessToken;
  deleteUser: typeof deleteUser;
  now: () => number;
}

const DEFAULT_DEPENDENCIES: AccessTokenLifecycleDependencies = {
  getDecryptedRefreshToken,
  refreshAccessToken,
  deleteUser,
  now: Date.now,
};

/**
 * Keeps access tokens in memory only for the lifetime of the provider. It
 * centralizes refresh-token revocation handling for every Google API caller.
 */
export class GoogleAccessTokenLifecycle implements GoogleAccessTokenProvider {
  private readonly cache = new Map<string, AccessTokenCacheEntry>();
  private readonly inFlightRefreshes = new Map<string, Promise<string>>();
  private readonly dependencies: AccessTokenLifecycleDependencies;

  constructor(
    private readonly env: GoogleAccessTokenEnv,
    dependencies: Partial<AccessTokenLifecycleDependencies> = {},
  ) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  }

  async getAccessToken(googleId: string): Promise<string> {
    const now = this.dependencies.now();
    const cached = this.cache.get(googleId);
    if (cached && cached.expires_at > now + 60_000) {
      return cached.token;
    }

    const inFlight = this.inFlightRefreshes.get(googleId);
    if (inFlight) return inFlight;

    const refresh = this.refreshAndCache(googleId);
    this.inFlightRefreshes.set(googleId, refresh);
    try {
      return await refresh;
    } finally {
      if (this.inFlightRefreshes.get(googleId) === refresh) {
        this.inFlightRefreshes.delete(googleId);
      }
    }
  }

  private async refreshAndCache(googleId: string): Promise<string> {
    const refreshToken = await this.dependencies.getDecryptedRefreshToken(
      this.env,
      googleId,
    );
    if (!refreshToken) {
      throw new Error(GSC_ACCESS_REVOKED_MESSAGE);
    }

    try {
      const tokens = await this.dependencies.refreshAccessToken(
        refreshToken,
        this.env.GOOGLE_CLIENT_ID,
        this.env.GOOGLE_CLIENT_SECRET,
      );
      this.cache.set(googleId, {
        token: tokens.access_token,
        expires_at: this.dependencies.now() + tokens.expires_in * 1000,
      });
      return tokens.access_token;
    } catch (err) {
      if (err instanceof GoogleRefreshTokenRevokedError) {
        this.cache.delete(googleId);
        await this.dependencies.deleteUser(this.env, googleId);
        console.warn('Refresh token revoked; deleted stored user credentials');
      }
      throw err;
    }
  }
}
