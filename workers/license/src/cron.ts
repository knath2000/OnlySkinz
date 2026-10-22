import type { Env } from "./types";

/**
 * Daily maintenance job.
 *
 * Phase 3 will implement:
 *   1. Mark trials past `trial_end` without payment as EXPIRED and revoke.
 *   2. Revoke licenses lapsed past `current_period_end` (CANCELLED/SUSPENDED
 *      beyond grace).
 *   3. Send renewal / payment-failure reminder emails.
 */
export async function runDaily(env: Env, now = Math.floor(Date.now() / 1000)): Promise<void> {
  const trials = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM subscribers WHERE status = 'TRIAL' AND trial_end IS NOT NULL AND trial_end < ?",
  )
    .bind(now)
    .first<{ n: number }>();

  console.log(
    `[cron] daily run at ${now}; expired trials pending: ${trials?.n ?? 0} (Phase 3 will revoke)`,
  );
}
