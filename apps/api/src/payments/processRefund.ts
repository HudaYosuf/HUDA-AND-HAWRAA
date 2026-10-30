import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ZERO_FILS, calculateRefundFee, compareFils, subtractFils, toFils, type Fils } from "@filspay/money";
import { enqueueEvent } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { claimIdempotencyKey, completeIdempotencyKey, failIdempotencyKey, hashRequest } from "./idempotency.js";
import { recordTransactionEvent } from "../transactions/events.js";
import { nextStatusAfterRefund } from "./refundState.js";
import { validateRefundRequest } from "./refundValidation.js";
import { ConflictError, UnprocessableEntityError } from "../lib/errors.js";

const ENDPOINT = "refunds.create";

export interface ProcessRefundInput {
  transactionId: string;
  merchantId: string;
  amountFils?: Fils;
  idempotencyKey: string;
  actor: { type: "merchant_session" | "merchant_api_key"; id: string };
  reason?: string;
}

export interface ProcessRefundResult {
  statusCode: number;
  body: unknown;
}

interface RefundTransactionRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  refunded_fils: string | number;
  acquirer_reference: string;
}

/** Refund business logic: validate, call the acquirer, then journal the reversal. */
export async function processRefund(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: ProcessRefundInput,
): Promise<ProcessRefundResult> {
  const requestHash = hashRequest({
    transactionId: input.transactionId,
    amountFils: input.amountFils ?? null,
    reason: input.reason ?? null,
  });

  // 1 validate
  const prepared = await withTransaction(pool, async (client) => {
    const claim = await claimIdempotencyKey(client, {
      merchantId: input.merchantId,
      endpoint: ENDPOINT,
      key: input.idempotencyKey,
      requestHash,
    });

    if (claim.outcome === "conflict_hash_mismatch") {
      throw new UnprocessableEntityError("idempotency_key_reused");
    }
    if (claim.outcome === "conflict_in_progress") {
      throw new ConflictError("request_in_progress");
    }
    if (claim.outcome === "replay") {
      return {
        kind: "settled" as const,
        result: { statusCode: claim.row.responseStatusCode ?? 200, body: claim.row.responseBody },
      };
    }

    const txnResult = await client.query<RefundTransactionRow>(
      `SELECT id, merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference
         FROM transactions
        WHERE id = $1
        FOR UPDATE`,
      [input.transactionId],
    );
    const txn = txnResult.rows[0];
    if (!txn || txn.merchant_id !== input.merchantId) {
      const body = { error: "transaction_not_found" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 404, body });
      return { kind: "settled" as const, result: { statusCode: 404, body } };
    }

    const capturedFils = toFils(Number(txn.captured_fils));
    const refundedFils = toFils(Number(txn.refunded_fils));
    const amountAuthorized = toFils(Number(txn.amount_fils));

    const refundableFils = subtractFils(capturedFils, refundedFils);

    const validation = validateRefundRequest(
      {
        id: txn.id,
        merchantId: txn.merchant_id,
        status: txn.status,
        capturedFils,
        refundableFils,
      },
      input.amountFils,
    );

    if (!validation.ok) {
      const statusCode = validation.code === "transaction_not_refundable" ? 409 : 422;
      await completeIdempotencyKey(client, claim.row.id, { statusCode, body: validation });
      return { kind: "settled" as const, result: { statusCode, body: validation } };
    }

    // Reserve the fils before we talk to the acquirer. The row lock ends
    // when this transaction commits, so a second refund must see the
    // reserved total or both can pass the check.
    const reserved = await client.query<{ refunded_fils: string }>(
      `UPDATE transactions
          SET refunded_fils = refunded_fils + $2
        WHERE id = $1
          AND refunded_fils + $2 <= captured_fils
        RETURNING refunded_fils`,
      [txn.id, validation.amountFils],
    );
    if ((reserved.rowCount ?? 0) === 0 || !reserved.rows[0]) {
      const body = { ok: false, code: "refund_exceeds_refundable", refundableFils };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 409, body });
      return { kind: "settled" as const, result: { statusCode: 409, body } };
    }
    const reservedTotal = toFils(Number(reserved.rows[0].refunded_fils));
    // #region agent log
    fetch("http://127.0.0.1:7583/ingest/d0a9b0b1-346f-4a44-91e6-22827f9be975", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "494ded" },
      body: JSON.stringify({
        sessionId: "494ded",
        runId: "post-fix",
        hypothesisId: "refund-race",
        location: "processRefund.ts:reserve",
        message: "reserved refund fils before acquirer call",
        data: { transactionId: txn.id, requested: validation.amountFils, reservedTotal },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    // The fee this transaction was actually charged at capture, read from
    // the ledger rather than recomputed from the merchant's current
    // mdr_bps, so a rate change after capture can never retroactively alter
    // what a refund reverses.
    const feeResult = await client.query<{ fee_fils: string }>(
      `SELECT COALESCE(SUM(amount_fils), 0)::text AS fee_fils
         FROM ledger_entries
        WHERE transaction_id = $1
          AND account_id = 'platform_fee_revenue'
          AND direction = 'credit'`,
      [txn.id],
    );
    const feeRow = feeResult.rows[0];
    if (!feeRow) {
      throw new Error("processRefund: fee aggregate returned no row");
    }

    return {
      kind: "proceed" as const,
      claimId: claim.row.id,
      attemptCount: claim.row.attemptCount,
      transactionId: txn.id,
      merchantId: txn.merchant_id,
      acquirerReference: txn.acquirer_reference,
      amountAuthorized,
      capturedFils,
      refundedFils: reservedTotal,
      feeChargedFils: toFils(Number(feeRow.fee_fils)),
      requestedAmount: validation.amountFils,
    };
  });

  if (prepared.kind === "settled") {
    return prepared.result;
  }

  // 2 acquirer
  const acquirerResult = await acquirer.refund({
    acquirerReference: prepared.acquirerReference,
    amountFils: prepared.requestedAmount,
    idempotencyKey: `${prepared.claimId}:${prepared.attemptCount}`,
  });

  // 3 journal
  return withTransaction(pool, async (client) => {
    if (acquirerResult.outcome === "declined" || acquirerResult.outcome === "error") {
      await client.query(`UPDATE transactions SET refunded_fils = refunded_fils - $2 WHERE id = $1`, [
        prepared.transactionId,
        prepared.requestedAmount,
      ]);
    }
    if (acquirerResult.outcome === "declined") {
      const body = { error: "refund_declined" };
      await completeIdempotencyKey(client, prepared.claimId, { statusCode: 402, body });
      return { statusCode: 402, body };
    }
    if (acquirerResult.outcome === "error") {
      const body = { error: "acquirer_unavailable" };
      await failIdempotencyKey(client, prepared.claimId, { statusCode: 502, body });
      return { statusCode: 502, body };
    }

    const newRefundedTotal = prepared.refundedFils;
    const newStatus = nextStatusAfterRefund({
      amountFils: prepared.amountAuthorized,
      capturedFils: prepared.capturedFils,
      refundedTotalFils: newRefunded
