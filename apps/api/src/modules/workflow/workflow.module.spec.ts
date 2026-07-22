import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { TicketsModule } from '../tickets/tickets.module';
import { NotificationService } from '../tickets/notification.service';
import { WorkflowModule } from './workflow.module';

// MailModule validates its config while this metadata-only test imports the
// module graph. Supply the three required development values before imports are
// evaluated; no Nest application or external service is started by this test.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
  process.env.TELECOM_HD_JWT_ACCESS_SECRET ??= 'test-access-secret-which-is-long-enough';
  process.env.TELECOM_HD_JWT_REFRESH_SECRET ??= 'test-refresh-secret-which-is-long-enough';
});

describe('WorkflowModule notification ownership', () => {
  it('uses the TicketsModule notification singleton instead of registering a second provider', () => {
    const workflowImports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, WorkflowModule) as unknown[];
    const workflowProviders = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, WorkflowModule) as unknown[];
    const ticketExports = Reflect.getMetadata(MODULE_METADATA.EXPORTS, TicketsModule) as unknown[];

    expect(workflowImports).toContain(TicketsModule);
    expect(workflowProviders).not.toContain(NotificationService);
    expect(ticketExports).toContain(NotificationService);
  });
});
