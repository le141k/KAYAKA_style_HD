import { parseExpression } from 'cron-parser';

/**
 * Compute the next fire time for a standard cron expression, strictly after
 * `from`. Interpreted in UTC so behaviour is identical regardless of the host
 * timezone (dev laptop vs prod container). Throws on an invalid expression.
 */
export function nextRunFromCron(cron: string, from: Date): Date {
  return parseExpression(cron, { currentDate: from, tz: 'UTC' }).next().toDate();
}

/** True when `cron` is a parseable expression. */
export function isValidCron(cron: string): boolean {
  try {
    parseExpression(cron);
    return true;
  } catch {
    return false;
  }
}
