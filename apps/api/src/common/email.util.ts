/**
 * Canonical email normalization (GOAL_PUBLIC_SECURITY S2-2).
 *
 * One stable ownership identity depends on a single, shared normalization rule: an email
 * is trimmed and lower-cased before it is stored in `UserEmail` or used as a lookup key.
 * This keeps `Foo@Bar.com` and `foo@bar.com` from resolving to different owners and makes
 * the client-auth `resolveUnambiguousOwner` reliable. Address-parsing beyond case/whitespace
 * (e.g. gmail dot/plus folding) is deliberately NOT done — it would merge distinct addresses.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
