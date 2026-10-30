import type { Pool } from "pg";
import { toFils } from "@filspay/money";
import { authorizeTransaction } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { applyCaptureDiscountAdjustment } from "../payments/discountAdjustment.js";
import type { AcquirerSimulator, SimulatedCardInput } from "../acquirer/types.js";

export interface PayPaymentLinkInput {
  token: string;
  card: SimulatedCardInput;
  idempotencyKey: string;
  submittedAt?: string;
}

export interface PayPaymentLinkResult {
  statusCode: number;
  body: unknown;
}

/** Returned by the claim UPDATE; merchant_id comes from the link row, never from the request. */
interface ClaimedLinkRow {
  id: string;
  merchant_id: string;
  amount_fils: string | number;
  reference: string | null;
}

interface LinkStatusRow {
  status: string;
  expires_at: Date;
}

/** Expiry is always the server clock. A client `submittedAt` must not
 *  let an expired link be paid. */
export function expiryReferenceTime(_submittedAt?: string): Date {
  return new Date();
}

/**
 * `POST /v1/payment-links/:token/pay` business logic (public,
 * unauthenticated). Calls `authorizeTransaction`
 * then `captureTransaction` directly, in sequence, never issuing an HTTP
 * request back into the API's own /v1/transactions routes.
 *
 * Concurrency: reserve the link with a single
 * atomic conditional UPDATE, release the row lock immediately, run
 * authorize+capture with no lock held on payment_links at all, then
 * finalize with a second atomic conditional UPDATE keyed on still being in
 * the 'reserved' state. A short, configurable reservation timeout
 * self-heals a link stuck 'reserved' by a crash between claim and
 * finalize, with no sweep job.
 */
export async function payPaymentLink(
  pool: Pool,
  acquirer: AcquirerSimulator,
  config: { paymentLinkReservationTimeoutSeconds: number },
  input: PayPaymentLinkInput,
): Promise<PayPaymentLinkResult> {
  const expiryCheckTime = expiryReferenceTime(input.submittedAt);

  // Step 1 — claim. A single UPDATE is already atomic; no explicit
  // transaction needed.
  // YA: one conditional UPDATE = atomic claim, no explicit txn needed. correct
  const claimResult = await pool.query<ClaimedLinkRow>(
    `UPDATE payment_links
        SET status = 'reserved', reserved_at = now()
      WHERE token = $1
        AND expires_at > $2
        AND (
          status = 'active'
          OR (
            status = 'reserved'
            AND reserved_at < now() - ($3::int * interval '1 second')
          )
        )
      RETURNING id, merchant_id, amount_fils, reference`,
    [input.token, expiryCheckTime, config.paymentLinkReservationTimeoutSeconds],
  );

  const claimedRow = claimResult.rows[0];
  if (!claimedRow) {
    return classifyClaimFailure(pool, input.token, config.paymentLinkReservationTimeoutSeconds, expiryCheckTime);
  }

  const link = {
    id: claimedRow.id,
    merchantId: claimedRow.merchant_id,
    amountFils: toFils(Number(claimedRow.amount_fils)),
    reference: claimedRow.reference,
  };

  const ourAuthorizeKey = `paylink:${link.id}:${input.idempotencyKey}:authorize`;
  const priorCaptures = await pool.query<{ key: string }>(
    `SELECT key FROM idempotency_keys
      WHERE merchant_id = $1
        AND endpoint = 'transactions.authorize'
        AND key LIKE $2
        AND status = 'completed'`,
    [link.merchantId, `paylink:${link.id}:%`],
  );
  if (priorCaptures.rows.some((row) => row.key !== ourAuthorizeKey)) {
    await pool.query(
      `UPDATE payment_links
          SET reserved_at = now() - ($2::int * interval '1 second') - interval '1 second'
        WHERE id = $1 AND status = 'reserved'`,
      [link.id, config.paymentLinkReservationTimeoutSeconds],
    );
    // #region agent log
    fetch("http://127.0.0.1:7583/ingest/d0a9b0b1-346f-4a44-91e6-22827f9be975", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "494ded" },
      body: JSON.stringify({
        sessionId: "494ded",
        runId: "post-fix",
        hypothesisId: "link-double-pay",
        location: "paymentLinks/pay.ts:second-buyer",
        message: "blocked a second buyer on a link that already captured",
        data: { linkId: link.id },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    return { statusCode: 409, body: { error: "payment_link_already_paid" } };
  }

  // Step 2 — authorize.
  // am: keys include link.id so two links can never collide on idempotency. good
  const authorizeKey = ourAuthorizeKey;
  const authResult = await authorizeTransaction(pool, acquirer, {
    merchantId: link.merchantId,
    amountFils: link.amountFils,
    card: input.card,
    reference: link.reference ?? undefined,
    idempotencyKey: authorizeKey,
    // No merchant session/API key initiated this — a customer did, via
    // the public link.
    actor: { type: "system" },
  });

  if (authResult.statusCode !== 201) {
    await releaseReservation(pool, link.id);
    return {
      statusCode: authResult.statusCode,
      body: { stage: "authorize", ...(authResult.body as Record<string, unknown>) },
    };
  }

  const txnId = (authResult.body as { id: string }).id;

  // NOTE: discountAdjustment is applied by the transactions route only, not here — FH
  // MK: it's applied for both now (moved into capture.ts in July)
  // Step 3 — capture (full amount, immediately). amountFils omitted =>
  // capture the full remaining amount — always correct here, since this
  // transaction was just authorized for exactly link.amountFils and
  // nothing else could have touched it yet.
  const captureKey = `paylink:${link.id}:${input.idempotencyKey}:capture`;
  const captureResult = await captureTransaction(pool, acquirer, {
    transactionId: txnId,
    merchantId: link.merchantId,
    idempotencyKey: captureKey,
    actor: { type: "system", id: link.id },
  });

  if (
