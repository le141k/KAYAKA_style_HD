import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MailService, OUTBOUND_STATUS_SELECT } from './mail.service';
import type { AppConfig } from '../../config/configuration';
import { MailAccessPolicy } from './mail-access-policy.service';

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: vi.fn().mockResolvedValue({ response: '250 accepted' }) })),
  },
  createTransport: vi.fn(() => ({ sendMail: vi.fn().mockResolvedValue({ response: '250 accepted' }) })),
}));

const CONFIG: AppConfig = {
  NODE_ENV: 'test',
  TELECOM_HD_API_PORT: 4000,
  TELECOM_HD_PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://localhost/test',
  REDIS_URL: 'redis://localhost:6379',
  TELECOM_HD_JWT_ACCESS_SECRET: 'test-access-secret-32chars-minimum',
  TELECOM_HD_JWT_REFRESH_SECRET: 'test-refresh-secret-32chars-min',
  TELECOM_HD_JWT_ACCESS_TTL: 900,
  TELECOM_HD_JWT_REFRESH_TTL: 2592000,
  TELECOM_HD_SMTP_HOST: 'localhost',
  TELECOM_HD_SMTP_PORT: 1025,
  TELECOM_HD_SMTP_SECURE: false,
  TELECOM_HD_MAIL_FROM: '23 Telecom <support@test.example>',
  TELECOM_HD_LOG_LEVEL: 'silent',
  TELECOM_HD_ALARIS_WEBHOOK_SECRET: 'test-inbound-secret-32chars-minimum',
  TELECOM_HD_INBOUND_WEBHOOK_SECRET: 'test-inbound-secret-32chars-minimum',
  TELECOM_HD_UPLOAD_DIR: '/tmp/uploads',
  TELECOM_HD_UPLOAD_MAX_SIZE_MB: 25,
  TELECOM_HD_UPLOAD_TOTAL_MAX_SIZE_MB: 50,
  TELECOM_HD_UPLOAD_REQUEST_MAX_SIZE_MB: 51,
  TELECOM_HD_INBOUND_MAX_SIZE_MB: 35,
  TELECOM_HD_ORPHAN_ATTACHMENT_TTL_HOURS: 24,
  TELECOM_HD_ORPHAN_ATTACHMENT_MAX_COUNT: 2000,
  TELECOM_HD_ORPHAN_ATTACHMENT_MAX_SIZE_MB: 2048,
  TELECOM_HD_UPLOAD_MIN_FREE_DISK_MB: 5120,
  TELECOM_HD_ATTACHMENT_CLEANUP_MAX_ITEMS: 1000,
  TELECOM_HD_ATTACHMENT_CLEANUP_MAX_RUN_SECONDS: 120,
  TELECOM_HD_PUBLIC_TICKET_CREATE_ENABLED: false,
  TELECOM_HD_PUBLIC_UPLOAD_ENABLED: false,
  TELECOM_HD_CLIENT_UPLOAD_ENABLED: false,
  TELECOM_HD_CLAMAV_ENABLED: false,
  TELECOM_HD_CLAMAV_HOST: 'clamav',
  TELECOM_HD_CLAMAV_PORT: 3310,
  TELECOM_HD_CLAMAV_TIMEOUT_MS: 15_000,
  TELECOM_HD_CLIENT_PORTAL_ENABLED: false,
  TELECOM_HD_IMAP_ENABLED: false,
  TELECOM_HD_IMAP_BOOTSTRAP_POLICY: 'FROM_NOW',
  TELECOM_HD_IMAP_BACKFILL_LIMIT: 0,
  TELECOM_HD_INBOUND_MAX_ATTEMPTS: 5,
  TELECOM_HD_INBOUND_RAW_RETENTION_DAYS: 30,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmoutbox00000000000000001',
    ticketId: 7,
    postId: 9,
    emailQueueId: 3,
    state: 'QUEUED',
    messageId: '<stable-outbox@test.example>',
    fromAddress: '23 Telecom <support@test.example>',
    replyToAddress: 'support@test.example',
    subject: 'Re: ticket',
    htmlBody: '<p>Hello</p>',
    textBody: 'Hello',
    inReplyTo: '<inbound@test.example>',
    references: ['<inbound@test.example>'],
    attempts: 0,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseVersion: 0,
    lastError: null,
    providerResponse: null,
    acceptedAt: null,
    sentAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    recipients: [
      { email: 'customer@example.test', role: 'TO' },
      { email: 'visible@example.test', role: 'CC' },
      { email: 'hidden@example.test', role: 'BCC' },
    ],
    attachments: [],
    ...overrides,
  } as any;
}

function makePrisma(outbound = row()) {
  const matches = (where: Record<string, any>): boolean => {
    const matchValue = (actual: unknown, expected: unknown): boolean => {
      if (expected === null) return actual === null;
      if (expected === undefined || typeof expected !== 'object' || expected instanceof Date) {
        return actual === expected;
      }
      const filter = expected as { in?: unknown[]; lt?: Date; lte?: Date };
      if (filter.in) return filter.in.includes(actual);
      if (filter.lt) return actual instanceof Date && actual < filter.lt;
      if (filter.lte) return actual instanceof Date && actual <= filter.lte;
      return false;
    };
    return Object.entries(where).every(([key, expected]) => {
      if (key === 'OR') return (expected as Record<string, any>[]).some((clause) => matches(clause));
      if (key === 'AND') return (expected as Record<string, any>[]).every((clause) => matches(clause));
      // Scope predicates are evaluated by Prisma against the related ticket in production.
      // The retry test below uses an administrator, so they are intentionally absent here.
      if (key === 'ticket') return true;
      return matchValue(outbound[key], expected);
    });
  };
  const outboundEmail = {
    updateMany: vi.fn(async ({ where = {}, data }: any) => {
      if (!matches(where)) return { count: 0 };
      if (data.state === 'PROCESSING') {
        outbound.state = 'PROCESSING';
        outbound.leaseOwner = data.leaseOwner;
        outbound.leaseExpiresAt = data.leaseExpiresAt;
        outbound.leaseVersion += data.leaseVersion?.increment ?? 0;
        outbound.attempts += data.attempts?.increment ?? 0;
      } else {
        Object.assign(outbound, data);
      }
      return { count: 1 };
    }),
    findUnique: vi.fn(async () => outbound),
    findFirst: vi.fn(async () => outbound),
    findMany: vi.fn(async () => []),
  };
  const tx = {
    outboundEmail,
    ticketPost: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    ticket: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    ticketAuditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return {
    emailTemplate: { findUnique: vi.fn() },
    outboundEmail,
    ticketPost: tx.ticketPost,
    ticket: tx.ticket,
    ticketAuditLog: tx.ticketAuditLog,
    departmentStaff: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    __outbound: outbound,
    __tx: tx,
  } as any;
}

function sendMail(service: MailService): ReturnType<typeof vi.fn> {
  return (service as unknown as { transporter: { sendMail: ReturnType<typeof vi.fn> } }).transporter.sendMail;
}

describe('MailService durable outbound outbox', () => {
  beforeEach(() => vi.clearAllMocks());

  it('claims with a DB lease and marks SENT + TicketPost.isEmailed only after SMTP acceptance', async () => {
    const prisma = makePrisma();
    const service = new MailService(CONFIG, prisma);

    await service.processOutboundEmail(prisma.__outbound.id);

    expect(sendMail(service)).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: '<stable-outbox@test.example>',
        to: 'customer@example.test',
        cc: 'visible@example.test',
        bcc: 'hidden@example.test',
      }),
    );
    expect(prisma.__outbound.state).toBe('SENT');
    expect(prisma.__outbound.acceptedAt).toBeInstanceOf(Date);
    expect(prisma.__tx.ticketPost.updateMany).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { isEmailed: true },
    });
    expect(prisma.__tx.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7, firstResponseAt: null },
        data: { firstResponseAt: expect.any(Date) },
      }),
    );
  });

  it('keeps the stable Message-ID across a retry and never marks the post emailed before success', async () => {
    const prisma = makePrisma();
    const service = new MailService(CONFIG, prisma);
    sendMail(service)
      .mockRejectedValueOnce({ responseCode: 421, code: 'ETEMP' })
      .mockResolvedValueOnce({ response: '250 OK' });

    await service.processOutboundEmail(prisma.__outbound.id);
    expect(prisma.__outbound.state).toBe('RETRY');
    expect(prisma.__tx.ticketPost.updateMany).not.toHaveBeenCalled();

    // Recovery would wait for the persisted backoff. Make this deterministic
    // unit test due without sleeping for a real minute.
    prisma.__outbound.nextAttemptAt = new Date(Date.now() - 1);
    await service.processOutboundEmail(prisma.__outbound.id);
    expect(prisma.__outbound.state).toBe('SENT');
    expect(sendMail(service).mock.calls[0]![0]).toEqual(
      expect.objectContaining({ messageId: '<stable-outbox@test.example>' }),
    );
    expect(sendMail(service).mock.calls[1]![0]).toEqual(
      expect.objectContaining({ messageId: '<stable-outbox@test.example>' }),
    );
  });

  it('records a network/SMTP uncertainty as AMBIGUOUS rather than falsely SENT', async () => {
    const prisma = makePrisma();
    const service = new MailService(CONFIG, prisma);
    sendMail(service).mockRejectedValueOnce({ code: 'ETIMEDOUT', message: 'socket timed out after DATA' });

    await service.processOutboundEmail(prisma.__outbound.id);

    expect(prisma.__outbound.state).toBe('AMBIGUOUS');
    expect(prisma.__outbound.acceptedAt).toBeNull();
    expect(prisma.__tx.ticketPost.updateMany).not.toHaveBeenCalled();
  });

  it('marks SMTP acceptance with a failed DB settlement AMBIGUOUS instead of retrying as a failed send', async () => {
    const prisma = makePrisma();
    prisma.$transaction.mockRejectedValueOnce(new Error('database lost after SMTP accept'));
    const service = new MailService(CONFIG, prisma);

    await service.processOutboundEmail(prisma.__outbound.id);

    expect(prisma.__outbound.state).toBe('AMBIGUOUS');
    expect(prisma.__outbound.lastError).toBe('SMTP accepted but delivery state could not be persisted');
    expect(prisma.__tx.ticketPost.updateMany).not.toHaveBeenCalled();
  });

  it('does not send when another worker wins the claim CAS', async () => {
    const prisma = makePrisma();
    // The first write is the harmless stale-lease quarantine check; the second
    // is the actual QUEUED/RETRY claim that another worker wins.
    prisma.outboundEmail.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 });
    const service = new MailService(CONFIG, prisma);

    await service.processOutboundEmail(prisma.__outbound.id);

    expect(sendMail(service)).not.toHaveBeenCalled();
  });

  it('turns an expired PROCESSING lease into AMBIGUOUS and never automatically re-sends it', async () => {
    const prisma = makePrisma(
      row({
        state: 'PROCESSING',
        leaseOwner: 'dead-worker',
        leaseVersion: 1,
        leaseExpiresAt: new Date(Date.now() - 1_000),
      }),
    );
    const service = new MailService(CONFIG, prisma);

    await service.processOutboundEmail(prisma.__outbound.id);

    expect(prisma.__outbound.state).toBe('AMBIGUOUS');
    expect(prisma.__outbound.lastError).toBe('Delivery worker lease expired; SMTP outcome is unknown');
    expect(sendMail(service)).not.toHaveBeenCalled();
  });

  it('uses immutable attachment metadata/storage snapshots in Nodemailer MIME', async () => {
    const prisma = makePrisma(
      row({
        attachments: [
          {
            fileName: 'invoice.pdf',
            mimeType: 'application/pdf',
            storageKey: 'tickets/7/invoice.pdf',
          },
        ],
      }),
    );
    const storage = { pathForKey: vi.fn().mockReturnValue('/safe/uploads/tickets/7/invoice.pdf') };
    const service = new MailService(CONFIG, prisma, undefined, storage as never);

    await service.processOutboundEmail(prisma.__outbound.id);

    expect(storage.pathForKey).toHaveBeenCalledWith('tickets/7/invoice.pdf');
    expect(sendMail(service)).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            filename: 'invoice.pdf',
            contentType: 'application/pdf',
            path: '/safe/uploads/tickets/7/invoice.pdf',
          },
        ],
      }),
    );
  });

  it('keeps a Redis enqueue failure durable and lets recovery scan retry the wake-up', async () => {
    const prisma = makePrisma();
    prisma.outboundEmail.findMany.mockResolvedValue([{ id: prisma.__outbound.id }]);
    const queue = { add: vi.fn().mockRejectedValue(new Error('redis unavailable')) };
    const service = new MailService(CONFIG, prisma, queue as never);

    await expect(service.enqueueOutbound(prisma.__outbound.id)).resolves.toBeUndefined();
    await service.recoverDurableOutbox();

    expect(prisma.__outbound.state).toBe('QUEUED');
    expect(queue.add).toHaveBeenCalledWith(
      'outbound',
      { outboundEmailId: prisma.__outbound.id },
      expect.objectContaining({ jobId: `mail:${prisma.__outbound.id}`, attempts: 1, removeOnFail: true }),
    );
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('manual retry requeues only terminal/uncertain mail without changing its Message-ID', async () => {
    const prisma = makePrisma(row({ state: 'AMBIGUOUS', attempts: 2 }));
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const service = new MailService(CONFIG, prisma, queue as never, undefined, new MailAccessPolicy(prisma));

    await service.retryOutboundEmail(prisma.__outbound.id, {
      staffId: 44,
      email: 'operator@example.test',
      isAdmin: true,
    });

    expect(prisma.__outbound.state).toBe('QUEUED');
    expect(prisma.__outbound.messageId).toBe('<stable-outbox@test.example>');
    expect(prisma.__tx.ticketAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'OUTBOUND_RETRY', staffId: 44 }) }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'outbound',
      { outboundEmailId: prisma.__outbound.id },
      expect.objectContaining({ jobId: `mail:${prisma.__outbound.id}` }),
    );
  });

  it('keeps BCC outside the staff timeline projection and sanitized relay outcome', async () => {
    const prisma = makePrisma();
    const service = new MailService(CONFIG, prisma);
    sendMail(service).mockResolvedValueOnce({ response: '250 accepted for hidden@example.test' });

    await service.processOutboundEmail(prisma.__outbound.id);

    expect(OUTBOUND_STATUS_SELECT).not.toHaveProperty('recipients');
    expect(prisma.__outbound.providerResponse).toBe('SMTP 250 accepted');
    expect(JSON.stringify(prisma.__outbound.providerResponse)).not.toContain('hidden@example.test');
  });
});
