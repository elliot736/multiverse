import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TenantUser } from '../auth/types.js';

/**
 * Standard middleware signature compatible with Node HTTP, Express, and similar frameworks.
 * Middleware receives the request, response, and a next function to call the next middleware.
 */
export type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => Promise<void>,
) => Promise<void>;

/**
 * Extended request type that includes tenant and user information
 * after passing through Multiverse middleware.
 */
export interface TenantRequest extends IncomingMessage {
  /** Authenticated user (set by auth middleware) */
  user?: TenantUser;
  /** Resolved tenant ID (set by tenant resolution middleware) */
  tenantId?: string;
}
