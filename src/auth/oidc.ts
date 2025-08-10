import * as jose from 'jose';
import type { JWTPayload } from 'jose';
import { AuthenticationError } from '../errors.js';
import type { TenantOidcConfig } from './types.js';

/**
 * Cached JWKS remote key set per JWKS URI.
 * Keys are cached to avoid refetching on every request.
 */
const jwksCache = new Map<string, jose.JWTVerifyGetKey>();

/**
 * Get or create a cached JWKS key set for a given URI.
 */
function getKeySet(jwksUri: string): jose.JWTVerifyGetKey {
  let keySet = jwksCache.get(jwksUri);
  if (!keySet) {
    keySet = jose.createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, keySet);
  }
  return keySet;
}

/**
 * Verify a JWT token and return the payload.
 *
 * @param token - The raw JWT string (without "Bearer " prefix)
 * @param config - OIDC configuration specifying JWKS URI, issuer, and audience
 * @returns The verified JWT payload
 * @throws AuthenticationError if verification fails
 */
export async function verifyToken(
  token: string,
  config: TenantOidcConfig,
): Promise<JWTPayload> {
  const keySet = getKeySet(config.jwksUri);

  try {
    const { payload } = await jose.jwtVerify(token, keySet, {
      issuer: config.issuer,
      audience: config.audience,
    });
    return payload;
  } catch (err) {
    if (err instanceof jose.errors.JWTExpired) {
      throw new AuthenticationError('Token expired');
    }
    if (err instanceof jose.errors.JWTClaimValidationFailed) {
      throw new AuthenticationError(`Token validation failed: ${err.message}`);
    }
    if (err instanceof jose.errors.JWSSignatureVerificationFailed) {
      throw new AuthenticationError('Invalid token signature');
    }
    throw new AuthenticationError(
      `Token verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Decode a JWT without verification. Used for extracting claims
 * before the full verification step (e.g., to determine which
 * tenant's OIDC provider to use).
 */
export function decodeToken(token: string): JWTPayload {
  try {
    const payload = jose.decodeJwt(token);
    return payload;
  } catch {
    throw new AuthenticationError('Invalid token format');
  }
}

/**
 * Clear the JWKS cache. Useful for testing or when keys are rotated.
 */
export function clearJwksCache(): void {
  jwksCache.clear();
}
