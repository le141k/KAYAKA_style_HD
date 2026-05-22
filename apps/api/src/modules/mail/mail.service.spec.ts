import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MailService } from './mail.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AppConfig } from '../../config/configuration';

// Mock nodemailer so we never actually try to connect
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue({ messageId: 'mock-id' }),
    })),
  },
  createTransport: vi.fn(() => ({
    sendMail: vi.fn().mockResolvedValue({ messageId: 'mock-id' }),
  })),
}));

function makePrismaMock() {
  return {
    emailTemplate: {
      findUnique: vi.fn(),
    },
  } as unknown as PrismaService;
}

const TEST_CONFIG: AppConfig = {
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
  TELECOM_HD_MAIL_FROM: 'support@test.example',
  TELECOM_HD_LOG_LEVEL: 'silent',
  TELECOM_HD_ALARIS_WEBHOOK_SECRET: 'test-secret',
};

const MOCK_TEMPLATE = {
  id: 1,
  key: 'ticket_created',
  locale: 'en',
  subject: 'Ticket {{mask}} was created',
  htmlBody: '<p>Hello {{name}}, your ticket {{mask}} is open.</p>',
  textBody: 'Hello {{name}}, your ticket {{mask}} is open.',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('MailService', () => {
  let service: MailService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new MailService(TEST_CONFIG, prisma as unknown as PrismaService);
  });

  // ─── renderTemplate ──────────────────────────────────────────────────────────

  describe('renderTemplate', () => {
    it('substitutes {{key}} placeholders in subject, html, and text', async () => {
      (prisma.emailTemplate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TEMPLATE);

      const result = await service.renderTemplate('ticket_created', 'en', {
        name: 'Jane',
        mask: 'TT-000042',
      });

      expect(result.subject).toBe('Ticket TT-000042 was created');
      expect(result.html).toContain('Hello Jane');
      expect(result.html).toContain('TT-000042');
      expect(result.text).toContain('Hello Jane');
    });

    it('replaces unknown placeholders with empty string', async () => {
      (prisma.emailTemplate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_TEMPLATE,
        subject: 'Hello {{unknown_var}}',
        htmlBody: '{{also_unknown}}',
        textBody: '{{also_unknown}}',
      });

      const result = await service.renderTemplate('ticket_created', 'en', {});

      expect(result.subject).toBe('Hello ');
      expect(result.html).toBe('');
    });

    it('falls back to English locale when requested locale is not found', async () => {
      (prisma.emailTemplate.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null) // Ukrainian not found
        .mockResolvedValueOnce(MOCK_TEMPLATE); // English fallback found

      const result = await service.renderTemplate('ticket_created', 'uk', { name: 'Іван', mask: 'TT-001' });

      // Should have called findUnique twice: once for 'uk', once for 'en'
      expect(prisma.emailTemplate.findUnique).toHaveBeenCalledTimes(2);
      expect(result.subject).toContain('TT-001');
    });

    it('does NOT attempt fallback when locale is already "en" and template is missing', async () => {
      (prisma.emailTemplate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.renderTemplate('nonexistent_key', 'en', { subject: 'fallback-subject' });

      // Only one call (no second attempt)
      expect(prisma.emailTemplate.findUnique).toHaveBeenCalledTimes(1);
      // Returns plain fallback with subject from vars
      expect(result.subject).toBe('fallback-subject');
    });

    it('returns fallback with key as subject when template is not found and no subject var', async () => {
      (prisma.emailTemplate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.renderTemplate('some_template', 'en', {});

      expect(result.subject).toBe('some_template');
      expect(result.html).toBe('{}');
      expect(result.text).toBe('{}');
    });

    it('returns fallback with JSON of vars when neither locale nor en found', async () => {
      (prisma.emailTemplate.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null) // de not found
        .mockResolvedValueOnce(null); // en not found

      const result = await service.renderTemplate('some_key', 'de', { ticket: 'TT-001' });

      expect(result.subject).toBe('some_key');
      expect(result.html).toContain('TT-001');
    });
  });

  // ─── send ────────────────────────────────────────────────────────────────────

  describe('send', () => {
    it('sends an email without throwing', async () => {
      // Should resolve without error (nodemailer is mocked)
      await expect(
        service.send({ to: 'user@example.com', subject: 'Test', html: '<p>Test</p>' }),
      ).resolves.toBeUndefined();
    });

    it('handles array recipients by joining with comma', async () => {
      await expect(
        service.send({ to: ['a@example.com', 'b@example.com'], subject: 'Multi', text: 'body' }),
      ).resolves.toBeUndefined();
    });
  });

  // ─── sendTemplate ────────────────────────────────────────────────────────────

  describe('sendTemplate', () => {
    it('renders template and calls send', async () => {
      (prisma.emailTemplate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TEMPLATE);

      const sendSpy = vi.spyOn(service, 'send').mockResolvedValue(undefined);

      await service.sendTemplate('user@example.com', 'ticket_created', 'en', {
        name: 'Test',
        mask: 'TT-001',
      });

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: expect.stringContaining('TT-001'),
        }),
      );
    });
  });
});
