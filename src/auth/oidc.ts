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
