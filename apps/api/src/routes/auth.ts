import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyPassword } from "../auth/passwords.js";
import { issueChallenge, verifyOtpCode } from "../auth/otp.js";
import { requireSession } from "../auth/middleware.js";
import { sendOtpCode } from "../auth/notifier.js";
import {
  createPendingSession,
  lookupPendingSession,
  promoteSession,
  revokeSession,
} from "../auth/sessions.js";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError, GoneError, TooManyRequestsError, UnauthorizedError } from "../lib/errors.js";

/**
 * A pre-computed argon2id hash of a fixed, never-used dummy password, at
 * the same cost parameters this app defaults to. Verified against on every
 * login attempt for an email/merchant pair that doesn't resolve to a real
 * user, so a failed lookup and a failed password check take comparable
 * time — the response is already generic ("invalid_credentials") in every
 * case; this narrows the timing side-channel to match.
 */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,p=1,t=2$/yKuaUqm4SW+pPt2oGNj4A$j5oxu/MdJJP86dClo0LJ0wsekKwkSbr1yA0uZSZgQcc";

interface LoginBody {
  merchantId?: string;
  email?: string;
  password?: string;
}

interface OtpVerifyBody {
  code?: string;
}

/** One row per (merchant_id, email); the same email may exist under several merchants. */
interface MerchantUserRow {
  id: string;
  merchant_id: string;
  email: string;
  role: "owner" | "finance" | "support";
  password_hash: string;
}

/**
 * Merchant login is two-step: POST /login checks merchantId+email+password
 * and issues a pending session cookie bound to an OTP challenge; POST
 * /otp/verify promotes it. A pending session authenticates nothing until
 * promoted.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** POST /v1/auth/login — step 1. */
  app.post<{ Body: LoginBody }>("/login", async (request, reply) => {
    const { merchantId, email, password } = request.body ?? {};
    if (!merchantId || !email || !password) {
      throw new BadRequestError("invalid_request", "merchantId, email and password are required");
    }

    const userResult = await app.db.query<MerchantUserRow>(
      `SELECT mu.id, mu.merchant_id, mu.email, mu.role, mu.password_hash
         FROM merchant_users mu
         JOIN merchants m ON m.id = mu.merchant_id
        WHERE mu.merchant_id = $1 AND mu.email = $2 AND m.status = 'active'`,
      [merchantId, email],
    );
    const user = userResult.rows[0];

    // timing-safe: hashes against a dummy when the user is missing. correct — FH
    const passwordOk = await verifyPassword(user ? user.password_hash : DUMMY_PASSWORD_HASH, password);

    // The same generic message in every failure case (no row, or wrong
    // password) — the response never discloses which part was wrong.
    if (!user || !passwordOk) {
      throw new UnauthorizedError("invalid_credentials");
    }

    const recipient = user;

    const { code, expiresAt, rawToken } = await withTransaction(app.db, async (client) => {
      const challenge = await issueChallenge(client, {
        merchantUserId: recipient.id,
        ttlMinutes: app.config.otpTtlMinutes,
        codeLength: app.config.otpCodeLength,
        maxAttempts: app.config.otpMaxAttempts,
      });
      const session = await createPendingSession(client, {
        merchantUserId: recipient.id,
        otpChallengeId: challenge.id,
        ttlMinutes: app.config.pendingSessionTtlMinutes,
        ipAddress: request.ip,
        userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
      });
      return { code: challenge.code, expiresAt: challenge.expiresAt, rawToken: session.rawToken };
    });

    sendOtpCode(request.log, app.config, { merchantUserId: recipient.id, email: recipient.email }, code);

    /*
       BUG 1 FIX: Missing Multiplication Operator in Cookie maxAge Calculation
       - Old code: `maxAge: app.config.pendingSessionTtlMinutes\n60` (missing `*`).
       - What's wrong?: Omitting the multiplication operator causes a syntax/compilation error.
       - What does it break?: Prevents the authentication routes file from compiling.
       - How does the fix work?: Added the multiplication sign (`*`) to correctly calculate cookie maxAge in seconds (`app.config.pendingSessionTtlMinutes * 60`).
    */
    reply.setCookie(app.config.cookieName, rawToken, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: app.config.cookieSecure,
      maxAge: app.config.pendingSessionTtlMinutes * 60,
    });

    const responseBody: Record<string, unknown> = {
      otpRequired: true,
      otpExpiresAt: expiresAt.toISOString(),
    };
    // dev only — stripped in production builds
    if (app.config.otpDevExpose) {
      responseBody.devOtpCode = code;
    }
    reply.code(200).send(responseBody);
  });

  app.post<{ Body: OtpVerifyBody }>(
    "/otp/verify",
    async (request, reply) => {
      const code = request.body?.code;
      if (!code) {
        throw new BadRequestError("invalid_request", "code is required");
      }

      const rawToken = request.cookies[app.config.cookieName];
      if (!rawToken) {
        throw new UnauthorizedError("no_pending_session");
      }
      const pending = await lookupPendingSession(app.db, rawToken);
      if (!pending || !pending.otpChallengeId) {
        throw new UnauthorizedError("no_pending_session");
      }

      const challengeResult = await app.db.query<{
        id: string;
        code_salt: string;
        code_hash: string;
        attempt_count: number;
        max_attempts: number;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        `SELECT id, code_salt, code_hash, attempt_count, max_attempts, expires_at, consumed_at
           FROM otp_challenges WHERE id = $1`,
        [pending.otpChallengeId],
      );
      const challenge = challengeResult.rows[0];
      if (!challenge || challenge.consumed_at !== null) {
        throw new GoneError("otp_expired");
      }
      if (challenge.expires_at.getTime() <= Date.now()) {
        throw new GoneError("otp_expired");
      }

      // am: check-then-increment is fine, max_attempts=5 so worst case is 5 guesses
      // MK: 5 guesses per parallel batch? if i fire 50 at once they all read attempt_count=0
      if (challenge.attempt_count >= challenge.max_attempts) {
        await revokeSession(app.db, pending.sessionId);
        throw new TooManyRequestsError("too_many_attempts");
      }

      const bumped = await app.db.query(
        `UPDATE otp_challenges
            SET attempt_count = attempt_count + 1
          WHERE id = $1
            AND attempt_count < max_attempts
            AND consumed_at IS NULL
          RETURNING attempt_count`,
        [challenge.id],
      );
      if ((bumped.rowCount ?? 0) === 0) {
        await revokeSession(app.db, pending.sessionId);
        throw new TooManyRequestsError("too_many_attempts");
      }

      const matches = verifyOtpCode(code, challenge.code_salt, challenge.code_hash);
      if (!matches) {
        throw new UnauthorizedError("invalid_code");
      }

      const merchantUserResult = await withTransaction(app.db, async (client) => {
        await client.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [challenge.id]);
        // promoteSession bumps expires_at to 12h server-side; the cookie maxAge doesn't matter because
        // MK: admin verify re-sets the cookie after this
