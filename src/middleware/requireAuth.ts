/**
 * requireAuth middleware
 * Validates the Supabase JWT in the Authorization: Bearer <token> header.
 * Applied to all routes that grant storage write access (/api/ports, /api/storage).
 *
 * Verification is done via Supabase's token introspection — we decode the JWT
 * using the SUPABASE_JWT_SECRET (project JWT secret, not the service role key)
 * so no extra network hop is needed per request.
 */
import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header.' });
    return;
  }

  const token = authHeader.slice(7);

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[AUTH] SUPABASE_URL or SUPABASE_ANON_KEY not configured');
    res.status(500).json({ error: 'Server misconfiguration.' });
    return;
  }

  // Use a request-scoped client to validate the user's JWT via getUser().
  // getUser() verifies the token signature against Supabase's signing key — safe for auth decisions.
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth:   { persistSession: false },
  });

  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    console.warn(`[AUTH] Rejected unauthenticated upload request | error: ${error?.message ?? 'no user'}`);
    res.status(401).json({ error: 'Invalid or expired token.' });
    return;
  }

  // Attach user id to request for downstream use (audit logging, rate limiting, etc.)
  (req as any).userId = user.id;
  next();
}
