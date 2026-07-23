import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { WorkflowEmailEventController } from '../workflow/workflow.controller';
import { WorkflowEmailEventService } from '../workflow/workflow-email-event.service';
import { EmailQueueController } from './email-queue.controller';
import { EmailQueueService } from './email-queue.service';

/**
 * Route registration regression test. This intentionally uses a real Nest HTTP
 * adapter (rather than calling controller methods) because Express matches the
 * first registered parameter route and can otherwise hide literal operational
 * endpoints behind `/admin/email-queues/:id`.
 */
describe('mail console HTTP route registration', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function createApp() {
    const queues = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockImplementation((id: number) => Promise.resolve({ route: 'queue', id })),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      reconcile: vi.fn(),
      health: vi.fn().mockResolvedValue({ route: 'inbound-health' }),
      listQuarantined: vi.fn().mockResolvedValue({ route: 'inbound-quarantine' }),
      getQuarantined: vi
        .fn()
        .mockImplementation((id: number) => Promise.resolve({ route: 'quarantine', id })),
      replayQuarantined: vi.fn(),
      listCaptured: vi.fn().mockResolvedValue({ route: 'inbound-captured' }),
      getCaptured: vi.fn().mockImplementation((id: number) => Promise.resolve({ route: 'captured', id })),
      promoteCaptured: vi.fn().mockResolvedValue({ promoted: true }),
    };
    const workflowEvents = {
      operatorHealth: vi.fn().mockResolvedValue({ route: 'workflow-health' }),
      listOperatorEvents: vi.fn().mockResolvedValue({ route: 'workflow-list' }),
      getOperatorEvent: vi
        .fn()
        .mockImplementation((id: string) => Promise.resolve({ route: 'workflow', id })),
      replayOperatorEvent: vi.fn(),
    };
    // Vitest's lightweight TS transform does not emit constructor metadata even
    // though the production Nest build does. Supply the two controller tokens so
    // this remains a real HTTP/router test rather than a direct-method test.
    Reflect.defineMetadata('design:paramtypes', [EmailQueueService], EmailQueueController);
    Reflect.defineMetadata('design:paramtypes', [WorkflowEmailEventService], WorkflowEmailEventController);
    const moduleRef = await Test.createTestingModule({
      controllers: [EmailQueueController, WorkflowEmailEventController],
      providers: [
        { provide: EmailQueueService, useValue: queues },
        { provide: WorkflowEmailEventService, useValue: workflowEvents },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return { app, queues, workflowEvents };
  }

  it('keeps literal inbound and workflow endpoints reachable beside the queue id route', async () => {
    const ctx = await createApp();
    const server = ctx.app.getHttpServer();

    await supertest(server)
      .get('/admin/email-queues/inbound/health')
      .expect(200)
      .expect({ route: 'inbound-health' });
    await supertest(server)
      .get('/admin/email-queues/inbound/quarantine')
      .expect(200)
      .expect({ route: 'inbound-quarantine' });
    await supertest(server)
      .get('/admin/email-queues/inbound/quarantine/123')
      .expect(200)
      .expect({ route: 'quarantine', id: 123 });
    await supertest(server)
      .get('/admin/email-queues/inbound/captured')
      .expect(200)
      .expect({ route: 'inbound-captured' });
    await supertest(server)
      .get('/admin/email-queues/inbound/captured/124')
      .expect(200)
      .expect({ route: 'captured', id: 124 });
    await supertest(server)
      .post('/admin/email-queues/inbound/captured/124/promote')
      .send({
        reason: 'Capture-only verification passed',
        expectedUpdatedAt: '2026-07-23T12:00:00.000Z',
      })
      .expect(201)
      .expect({ promoted: true });
    await supertest(server)
      .get('/admin/workflow-email-events/health')
      .expect(200)
      .expect({ route: 'workflow-health' });
    await supertest(server)
      .get('/admin/workflow-email-events')
      .expect(200)
      .expect({ route: 'workflow-list' });
    await supertest(server)
      .get('/admin/workflow-email-events/event-123')
      .expect(200)
      .expect({ route: 'workflow', id: 'event-123' });
    await supertest(server).get('/admin/email-queues/42').expect(200).expect({ route: 'queue', id: 42 });

    expect(ctx.queues.get).toHaveBeenCalledWith(42, undefined);
    expect(ctx.workflowEvents.operatorHealth).toHaveBeenCalledWith(undefined);
  });
});
