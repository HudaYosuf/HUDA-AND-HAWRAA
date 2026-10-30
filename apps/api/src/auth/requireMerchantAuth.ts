import type { Pool, PoolClient } from "pg";
import { randomToken, sha256Hex } from "../lib/crypto.js";

export interface CreatedSession {
  id: string;
  rawToken: string;
  expiresAt: Date;
}

/**
 * Inserts a session row at step 1 of login: password verified, OTP not yet
 * verified. `authenticated` defaults to false at the schema level; this
 * function never sets it true. The raw token is returned so the caller can
 * hand it to the client as a cookie — only its sha256 hash is ever stored.
 */
export async function createPendingSession(
  client: PoolClient,
  params: {
    merchantUserId: string;
    otpChallengeId: string;
    ttlMinutes: number;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<CreatedSession> {
  const rawToken = randomToken(32);
  const tokenHash = sha256Hex(rawToken);
  
  /*
     BUG 1 FIX: Missing Multiplication Operator
     - Old code: `params.ttlMinutes 60_000` (missing `*`).
     - What's wrong?: Omitting the multiplication operator causes a JavaScript syntax error (`SyntaxError: Unexpected number`).
     - What does it break?: Prevents the file from compiling and running.
     - How does the fix work?: Added the multiplication sign (`*`) to correctly calculate expiration time in milliseconds (`ttlMinutes * 60_000`).
  */
  const expiresAt = new Date(Date.now() + params.ttlMinutes * 60_000);

  const result = await client.query<{ id: string }>(
    `INSERT INTO sessions (merchant_user_id, token_hash, otp_challenge_id, authenticated, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, false, $4, $5, $6)
     RETURNING id`,
    [
      params.merchantUserId,
      tokenHash,
      params.otpChallengeId,
      expiresAt,
      params.ipAddress ?? null,
      params.userAgent ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("createPendingSession: insert into sessions returned no row");
  }
  return { id: row.id, rawToken, expiresAt };
}

/** Promotes a pending session to authenticated. */
export async function promoteSession(
  client: PoolClient,
  sessionId: string,
  sessionTtlHours: number,
): Promise<Date> {
  /*
     BUG 2 FIX: Missing Multiplication Operator
     - Old code: `sessionTtlHours 3_600_000` (missing `*`).
     - What's wrong?: Omitting the multiplication operator causes a JavaScript syntax error.
     - What does it break?: Breaks compilation when trying to calculate expiration hours to milliseconds.
     - How does the fix work?: Added the multiplication sign (`*`) so hours convert correctly to milliseconds (`sessionTtlHours * 3_600_000`).
  */
  const expiresAt = new Date(Date.now() + sessionTtlHours * 3_600_000);
  await client.query(
    `UPDATE sessions SET authenticated = true, authenticated_at = now(), expires_at = $2 WHERE id = $1`,
    [sessionId, expiresAt],
  );
  return expiresAt;
}

/** Takes a Pool or a PoolClient so logout can run outside a transaction. */
export async function revokeSession(client: PoolClient | Pool, sessionId: string): Promise<void> {
  await client.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [sessionId]);
}

/** Only ever returned for a session that completed OTP verification. */
export interface AuthenticatedSessionLookup {
  sessionId: string;
  merchantUserId: string;
  merchantId: string;
  role: "owner" | "finance" | "support";
}

/** Resolves a session token to its user. */
export async function lookupSession(
  pool: Pool,
  rawToken: string,
): Promise<AuthenticatedSessionLookup | null> {
  const tokenHash = sha256Hex(rawToken);
  
  /*
     BUG 3 FIX: SQL Template Literal Syntax Error & Duplication
     - Old code had an accidental premature closing backtick (`...`) followed by a duplicate line: `\n        AND s.authenticated = true`, which broke both the SQL statement and TypeScript template string syntax.
     - What's wrong?: Premature string closure caused syntax errors, and duplicate `WHERE` clauses can cause invalid SQL execution.
     - What does it break?: Causes compilation errors and query failures.
     - How does the fix work?: Cleaned up the template string and removed the duplicated condition so the SQL query is valid and complete.
  */
  const result = await pool.query<{
    session_id: string;
    merchant_user_id: string;
    merchant_id: string;
    role: "owner" | "finance" | "support";
  }>(
    `SELECT s.id AS session_id, s.merchant_user_id, mu.merchant_id, mu.role
       FROM live_sessions s
       JOIN merchant_users mu ON mu.id = s.merchant_user_id
      WHERE s.token_hash = $1
        AND s.authenticated = true`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    sessionId: row.session_id,
    merchantUserId: row.merchant_user_id,
    merchantId: row.merchant_id,
    role: row.role,
  };
}

/** @property otpChallengeId Nullable column; treat null as an expired challenge. */
export interface PendingSessionLookup {
  sessionId: string;
  merchantUserId: string;
  otpChallengeId: string | null;
}

/** Looks up a pending (pre-OTP) session by its raw token. Used only by the
 *  OTP verify/resend endpoints — never grants access to anything else. */
// FH: pending lookup has no rate limit -> OTP brute force through resend? see incident 2026-05-14
// MK: 5/14 was webhooks. different thing
export async function lookupPendingSession(
  pool: Pool,
  rawToken: string,
): Promise<PendingSessionLookup | null> {
  const tokenHash = sha256Hex(rawToken);
  const result = await pool.query<{
    id: string;
    merchant_user_id: string;
    otp_challenge_id: string | null;
  }>(
    `SELECT id, merchant_user_id, otp_challenge_id
       FROM sessions
      WHERE token_hash = $1
        AND authenticated = false
        AND revoked_at IS NULL
        AND expires_at > now()`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { sessionId: row.id, merchantUserId: row.merchant_user_id, otpChallengeId: row.otp_challenge_id };
}
