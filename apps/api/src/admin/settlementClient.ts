import type { Config } from "../config.js";
import { AppError } from "../lib/errors.js";

export type SettlementInternalConfig = Pick<
  Config,
  "settlementInternalUrl" | "settlementInternalToken" | "settlementInternalRequestTimeoutMs"
>;

export interface MerchantBatchOutcome {
  merchantId: string;
  batchId: string;
  alreadyClosed: boolean;
  alreadyPaid: boolean;
  grossFils: number;
  feeFils: number;
  netPayoutFils: number;
}

export interface RunBatchSummary {
  businessDate: string;
  merchantResults: MerchantBatchOutcome[];
}

export interface RebuildDiff {
  merchantId: string;
  before: number;
  after: number;
}

export interface RebuildSummary {
  /** How many merchants the rebuild examined. */
  rebuiltCount: number;
  /** 
   * BUG 1 FIX: 
   * - Old code had hyphens (-) instead of asterisks (*) at the start of these lines.
   * - What's wrong?: JSDoc comments require asterisks (*) for continuation lines.
   * - Why change/Fix work?: Replaced hyphens with asterisks so IDE hover tooltips 
   *   render correctly and linting errors/warnings are prevented.
   */
  changed: RebuildDiff[];
}

export interface MdrBatchAdjustment {
  batchId: string;
  batchDate: string;
  status: string;
  oldFeeFils: number;
  newFeeFils: number;
  diffFils: number;
}

export interface MdrRecalcSummary {
  /** How many batches fell inside the requested date range. */
  batchesConsidered: number;
  /** Only the batches whose fee actually changed. */
  adjusted: MdrBatchAdjustment[];
}

/**
 * Reads a field from a decoded Go JSON object under any of the spellings a
 * Go struct may serialize to. Go's `encoding/json` uses the exported field
 * name verbatim unless a `json:"..."` tag says otherwise, so the same struct
 * legitimately arrives as `MerchantID` or `merchantId` depending on whether
 * tags are present. Accepting both keeps this client correct either way
 * rather than depending on a detail neither side's contract pins down.
 */
function pick(source: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (source[name] !== undefined) return source[name];
  }
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One `fetch` against apps/settlement's internal HTTP server, with an
 * `AbortController`-driven timeout and a bearer token.
 *
 * The two failure modes are deliberately distinct:
 * the call never completed (connection refused, DNS failure, timeout) ->
 *     502 `settlement_unreachable`. Nothing ran; retrying is safe.
 * the call completed and settlement itself reported failure (non-2xx) ->
 *     500 `settlement_run_failed`. Something may have partially run; the
 *     operator needs to look at settlement, not retry blindly.
 * Collapsing these two into one status would tell an operator nothing about
 * which of the two situations they are in.
 */
async function callSettlementInternal(
  config: SettlementInternalConfig,
  path: string,
  body: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.settlementInternalRequestTimeoutMs);

  let response: Response;
  try {
    response = await fetch(`${config.settlementInternalUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.settlementInternalToken}`,
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
  } catch (err) {
    throw new AppError(
      502,
      "settlement_unreachable",
      `settlement internal call to ${path} failed: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let excerpt = "";
    try {
      excerpt = (await response.text()).slice(0, 500);
    } catch {
      excerpt = "";
    }
    throw new AppError(
      500,
      "settlement_run_failed",
      `settlement internal call to ${path} returned ${response.status}: ${excerpt}`,
    );
  }
} 
/* 
   BUG 2 FIX:
   - Old code: The closing curly brace `}` for the `callSettlementInternal` function was missing entirely.
   - What's wrong?: Functions must be properly closed with a matching bracket.
   - What does it break?: Causes a fatal TypeScript compilation/syntax error, preventing the file and project from building.
   - How does the fix work?: Added the missing closing brace `}` to properly close the function block.
*/
