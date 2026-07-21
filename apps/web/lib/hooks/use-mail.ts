'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ─── API shapes (BigInt cursor fields arrive as STRINGS via the API serializer) ──

export type EmailQueueSyncState = 'OK' | 'BOOTSTRAPPING' | 'NEEDS_RECONCILIATION';

export interface AdminEmailQueue {
  id: number;
  type: 'IMAP' | 'POP3' | 'PIPE';
  emailAddress: string;
  host: string;
  port: number;
  username: string;
  useTls: boolean;
  departmentId: number | null;
  isEnabled: boolean;
  syncState: EmailQueueSyncState;
  lastError: string | null;
  lastSeenUid: string;
  uidValidity: string | null;
  cursorGeneration: number;
  bootstrapPolicy: 'FROM_NOW' | 'BACKFILL' | null;
  bootstrapBackfillLimit: number | null;
  lastConnectedAt: string | null;
  lastPollAt: string | null;
  lastAcceptedAt: string | null;
}

export interface InboundAlert {
  severity: 'warning' | 'critical';
  kind: string;
  message: string;
}

export interface InboundHealth {
  queues: Array<
    Pick<
      AdminEmailQueue,
      | 'id'
      | 'emailAddress'
      | 'isEnabled'
      | 'syncState'
      | 'lastError'
      | 'lastSeenUid'
      | 'uidValidity'
      | 'cursorGeneration'
      | 'bootstrapPolicy'
      | 'lastConnectedAt'
      | 'lastPollAt'
      | 'lastAcceptedAt'
    >
  >;
  ledger: {
    backlog: number;
    byState: {
      accepted: number;
      processing: number;
      retry: number;
      quarantined: number;
      processed: number;
      skipped: number;
    };
    stalledProcessing: number;
    oldestPendingAt: string | null;
    lastProcessedAt: string | null;
  };
  alerts: InboundAlert[];
  checkedAt: string;
}

export interface QuarantinedDelivery {
  id: number;
  transport: 'IMAP' | 'PIPE';
  queueId: number | null;
  messageId: string | null;
  envelopeFrom: string | null;
  envelopeTo: string | null;
  subject: string;
  sizeBytes: number;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ReconcileMode = 'RESUME_MIGRATED' | 'FROM_NOW' | 'BACKFILL';

export interface ReconcileInput {
  id: number;
  mode: ReconcileMode;
  reason?: string;
  confirm?: boolean;
  backfillLimit?: number;
}

const mailKeys = {
  queues: ['admin', 'email-queues'] as const,
  health: ['admin', 'inbound-health'] as const,
  quarantine: ['admin', 'inbound-quarantine'] as const,
};

export function useEmailQueues() {
  return useQuery({
    queryKey: mailKeys.queues,
    queryFn: () => api.get<AdminEmailQueue[]>('/admin/email-queues'),
  });
}

export function useInboundHealth() {
  return useQuery({
    queryKey: mailKeys.health,
    queryFn: () => api.get<InboundHealth>('/admin/email-queues/inbound/health'),
    // Health is a live operational view — refresh periodically.
    refetchInterval: 30_000,
  });
}

export function useQuarantine() {
  return useQuery({
    queryKey: mailKeys.quarantine,
    queryFn: () => api.get<QuarantinedDelivery[]>('/admin/email-queues/inbound/quarantine'),
  });
}

export function useReconcileQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ReconcileInput) =>
      api.post<{ reconciled: boolean }>(`/admin/email-queues/${id}/reconcile`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: mailKeys.queues });
      void qc.invalidateQueries({ queryKey: mailKeys.health });
    },
  });
}

export function useReplayQuarantined() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deliveryId: number) =>
      api.post<{ replayed: boolean }>(`/admin/email-queues/inbound/quarantine/${deliveryId}/replay`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: mailKeys.quarantine });
      void qc.invalidateQueries({ queryKey: mailKeys.health });
    },
  });
}
