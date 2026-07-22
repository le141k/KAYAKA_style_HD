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
  mailboxEpoch?: number;
  reconcileCause?: string | null;
  reconcileRequestedAt?: string | null;
  allowedModes?: ReconcileMode[];
  routingPriority?: number;
  lastConnectionAttemptAt?: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt?: string | null;
  lastConnectionErrorAt?: string | null;
  lastPollStartedAt?: string | null;
  lastPollAt: string | null;
  lastPollCompletedAt?: string | null;
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
      | 'mailboxEpoch'
      | 'reconcileCause'
      | 'reconcileRequestedAt'
      | 'lastConnectionAttemptAt'
      | 'lastConnectedAt'
      | 'lastDisconnectedAt'
      | 'lastConnectionErrorAt'
      | 'lastPollStartedAt'
      | 'lastPollAt'
      | 'lastPollCompletedAt'
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
    quarantineBytes: number;
    stalledProcessing: number;
    oldestPendingAt: string | null;
    lastProcessedAt: string | null;
  };
  rawStorage: {
    availableBytes: string;
    reserveBytes: string;
    nearReserve: boolean;
  } | null;
  alerts: InboundAlert[];
  checkedAt: string;
}

export interface QuarantinedDelivery {
  id: number;
  transport: 'IMAP' | 'PIPE';
  queueId: number | null;
  /** Legacy API name during the delivery-claim expand phase. */
  messageId?: string | null;
  /** Non-unique observed RFC Message-ID after the claim cutover. */
  observedMessageId?: string | null;
  envelopeFrom: string | null;
  envelopeTo: string | null;
  subject: string;
  sizeBytes: number;
  attempts: number;
  lastError: string | null;
  truncated: boolean;
  /** Server capability; never infer safety from only a local UI flag. */
  replayAllowed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QuarantinePage {
  items: QuarantinedDelivery[];
  total: number;
  page: number;
  limit: number;
}

export interface QuarantineDetail {
  delivery: QuarantinedDelivery & { state: 'QUARANTINED'; replayBlockReason?: string | null };
  audit: Array<{
    id: number;
    actorStaffId: number | null;
    actorEmail: string;
    action: string;
    reason: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
}

export interface QuarantineFilters {
  page?: number;
  limit?: number;
  queueId?: number;
  reason?: string;
  messageId?: string;
}

export type ReconcileMode = 'RESUME_MIGRATED' | 'FROM_NOW' | 'BACKFILL';

export interface ReconcileInput {
  id: number;
  mode: ReconcileMode;
  reason?: string;
  confirm?: boolean;
  backfillLimit?: number;
  expectedCursorGeneration?: number;
}

const mailKeys = {
  queues: ['admin', 'email-queues'] as const,
  health: ['admin', 'inbound-health'] as const,
  quarantine: (filters: QuarantineFilters) => ['admin', 'inbound-quarantine', filters] as const,
  quarantineDetail: (id: number) => ['admin', 'inbound-quarantine', id] as const,
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

export function useQuarantine(filters: QuarantineFilters = {}) {
  const normalized = { page: 1, limit: 25, ...filters };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(normalized)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return useQuery({
    queryKey: mailKeys.quarantine(normalized),
    queryFn: () => api.get<QuarantinePage>(`/admin/email-queues/inbound/quarantine?${params.toString()}`),
  });
}

export function useQuarantineDetail(deliveryId: number | null) {
  return useQuery({
    queryKey: mailKeys.quarantineDetail(deliveryId ?? 0),
    queryFn: () => api.get<QuarantineDetail>(`/admin/email-queues/inbound/quarantine/${deliveryId}`),
    enabled: deliveryId !== null,
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
    mutationFn: ({
      deliveryId,
      reason,
      expectedUpdatedAt,
    }: {
      deliveryId: number;
      reason: string;
      expectedUpdatedAt: string;
    }) =>
      api.post<{ replayed: boolean }>(`/admin/email-queues/inbound/quarantine/${deliveryId}/replay`, {
        reason,
        expectedUpdatedAt,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'inbound-quarantine'] });
      void qc.invalidateQueries({ queryKey: mailKeys.health });
    },
  });
}
