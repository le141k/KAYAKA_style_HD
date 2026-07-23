import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { AppConfig } from './config/configuration';
import { BigIntSerializerInterceptor } from './common/bigint-serializer.interceptor';
import { inboundSecretMatches } from './common/inbound-secret.util';
import { tryNormalizePipeDeliveryId, tryParsePipeQueueId } from './modules/mail/pipe-input.util';

/**
 * Register the PIPE ingress guard and parsers in the only safe order:
 * secret check first, then the route-specific large parser, followed by the
 * small global parser registered by `createApiApp`.  Exported separately so
 * HTTP-level tests exercise the exact production middleware order.
 */
export function configureInboundPipeMiddleware(
  app: Pick<express.Application, 'use'>,
  config: Pick<
    AppConfig,
    | 'TELECOM_HD_INBOUND_WEBHOOK_SECRET'
    | 'TELECOM_HD_INBOUND_MAX_SIZE_MB'
    | 'TELECOM_HD_INBOUND_DELIVERY_ENABLED'
    | 'TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED'
    | 'TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID'
    | 'TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID'
    | 'TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID'
  >,
): void {
  const inboundLimit = `${config.TELECOM_HD_INBOUND_MAX_SIZE_MB}mb`;
  app.use('/api/inbound/pipe', (req: Request, res: Response, next: NextFunction) => {
    const headerVal = req.headers['x-inbound-secret'];
    const provided = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    if (!inboundSecretMatches(provided, config.TELECOM_HD_INBOUND_WEBHOOK_SECRET)) {
      res.status(403).json({ statusCode: 403, message: 'Invalid inbound webhook secret' });
      return;
    }
    // This is deliberately before the route-specific raw/JSON body parsers. During a
    // code/migration cutover an authenticated MTA must receive a retryable failure,
    // while the API must neither allocate/parse the MIME nor create an InboundDelivery.
    // Capture-only is deliberately IMAP-only. Reject all PIPE requests here (before
    // either body parser) even if a stale environment points the capture id at a PIPE
    // queue: the Gmail canary must never retain MTA traffic as a side effect.
    if (config.TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED === true) {
      res
        .status(503)
        .json({ statusCode: 503, message: 'PIPE ingress is disabled during IMAP capture-only mode' });
      return;
    }
    // The normal canary is promotion-only. Reject at the header boundary (not
    // merely in InboundMailService) so authenticated MTA traffic cannot force
    // MIME buffering or retry churn while the one captured row is processed.
    if (
      config.TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID !== undefined ||
      config.TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID !== undefined
    ) {
      res
        .status(503)
        .json({
          statusCode: 503,
          message: 'PIPE ingress is disabled during the promotion-only inbound canary',
        });
      return;
    }
    if (!config.TELECOM_HD_INBOUND_DELIVERY_ENABLED) {
      res.status(503).json({ statusCode: 503, message: 'Inbound delivery is temporarily disabled' });
      return;
    }
    // Validate every required, bounded transport identity while the request is still
    // header-only. A valid shared secret must not let malformed PIPE traffic allocate
    // up to TELECOM_HD_INBOUND_MAX_SIZE_MB merely to receive a deterministic 400.
    const rawDeliveryId = req.headers['x-inbound-delivery-id'];
    const rawQueueId = req.headers['x-inbound-queue-id'];
    const deliveryId = tryNormalizePipeDeliveryId(
      Array.isArray(rawDeliveryId) ? rawDeliveryId[0] : rawDeliveryId,
    );
    const queueId = tryParsePipeQueueId(Array.isArray(rawQueueId) ? rawQueueId[0] : rawQueueId);
    if (deliveryId === null || queueId === null) {
      res
        .status(400)
        .json({ statusCode: 400, message: 'Valid PIPE delivery and queue headers are required' });
      return;
    }
    next();
  });
  app.use(
    '/api/inbound/pipe',
    express.raw({ type: ['message/rfc822', 'application/octet-stream'], limit: inboundLimit }),
  );
  app.use('/api/inbound/pipe', express.json({ limit: inboundLimit }));
}

/**
 * Build the HTTP application without binding a TCP port.  `main.ts` is now only
 * the process entry point; test suites can construct the same parser/serializer/
 * security pipeline without duplicating a subtly different setup.
 */
export async function createApiApp(config: AppConfig) {
  // Load the root module lazily. This keeps the parser-order helper importable in a tiny Express
  // HTTP test without eagerly evaluating modules that validate production environment variables.
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create(AppModule, { bufferLogs: true, bodyParser: false });
  const expressInstance = app.getHttpAdapter().getInstance() as express.Application;

  configureInboundPipeMiddleware(expressInstance, config);
  // Global defaults for every route other than raw RFC822 PIPE ingress.
  expressInstance.use(express.json({ limit: '1mb' }));
  expressInstance.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Trust the first proxy hop (Caddy/nginx) so req.ip / X-Forwarded-* reflect the
  // real client — without this the per-IP rate limiter keys on the proxy's IP.
  expressInstance.set('trust proxy', 1);

  app.useLogger(app.get(Logger));
  const isProd = config.NODE_ENV === 'production';
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'self'"],
          'script-src': isProd ? ["'self'"] : ["'self'", "'unsafe-inline'"],
          'style-src': isProd ? ["'self'"] : ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // IMAP UID/UIDVALIDITY are BigInt. JSON.stringify would otherwise throw before
  // an operator can read a health or queue response.
  app.useGlobalInterceptors(new BigIntSerializerInterceptor());
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.TELECOM_HD_PUBLIC_URL, credentials: true });

  if (!isProd) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('23 Telecom Help Desk API')
      .setDescription('NestJS 10 + Prisma + PostgreSQL helpdesk backend')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  app.enableShutdownHooks();
  return app;
}
