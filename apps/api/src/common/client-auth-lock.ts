import type { Prisma } from '@prisma/client';

/** Two-int PostgreSQL advisory-lock namespace (`CAUT`) for per-user client-auth changes. */
export const CLIENT_AUTH_LOCK_NAMESPACE = 0x43415554;

/** Serialize login issuance/verification with every client-identity mutation for one user. */
export async function lockClientIdentity(tx: Prisma.TransactionClient, userId: number): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      CAST(${CLIENT_AUTH_LOCK_NAMESPACE} AS integer),
      CAST(${userId} AS integer)
    )
  `;
}
