import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadConfig } from './config/configuration';
import { BigIntSerializerInterceptor } from './common/bigint-serializer.interceptor';

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  // Own the body parsers so the inbound webhook can accept a full raw RFC822 message
  // (real mail + attachments) as bytes with an explicit large limit, without inflating
  // the limit for every other JSON route.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, bodyParser: false });
  const inboundLimit = `${config.TELECOM_HD_INBOUND_MAX_SIZE_MB}mb`;
  // Validate the inbound-webhook shared secret BEFORE the large body parsers below, so an
  // unauthenticated caller is rejected in constant time without us buffering up to the
  // inbound size limit. The controller re-checks the secret (defence in depth); this guard
  // only closes the "buffer-then-reject" amplification window on the ingress path.
  const inboundSecret = Buffer.from(config.TELECOM_HD_INBOUND_WEBHOOK_SECRET, 'utf8');
  app.use('/api/inbound/pipe', (req: Request, res: Response, next: NextFunction) => {
    const headerVal = req.headers['x-inbound-secret'];
    const providedStr = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    const provided = Buffer.from(typeof providedStr === 'string' ? providedStr : '', 'utf8');
    const ok = provided.byteLength === inboundSecret.byteLength && timingSafeEqual(provided, inboundSecret);
    if (!ok) {
      res.status(403).json({ statusCode: 403, message: 'Invalid inbound webhook secret' });
      return;
    }
    next();
  });
  // Route-specific parsers (registration order wins): raw bytes for an MTA that POSTs the
  // message verbatim, or a large JSON `{ raw }` body. Only reached after the secret check.
  app.use(
    '/api/inbound/pipe',
    express.raw({ type: ['message/rfc822', 'application/octet-stream'], limit: inboundLimit }),
  );
  app.use('/api/inbound/pipe', express.json({ limit: inboundLimit }));
  // Global defaults for every other route (modest limit).
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Trust the first proxy hop (Caddy/nginx) so req.ip / X-Forwarded-* reflect the
  // real client — without this the per-IP rate limiter keys on the proxy's IP and
  // collapses all clients into one bucket.
  const expressInstance = app.getHttpAdapter().getInstance() as { set?: (k: string, v: unknown) => void };
  expressInstance.set?.('trust proxy', 1);

  // Use Pino as the application-level logger (replaces NestJS default)
  app.useLogger(app.get(Logger));

  const isProd = config.NODE_ENV === 'production';

  // Security headers (applies in dev + prod). The API is JSON-only behind a
  // reverse proxy in prod, so we use a strict CSP there. In non-prod we relax
  // script/style-src just enough for the self-hosted Swagger UI at /api/docs.
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

  // Serialize BigInt columns (IMAP UID cursors) as strings — JSON.stringify throws on
  // BigInt, and the values can exceed Number.MAX_SAFE_INTEGER.
  app.useGlobalInterceptors(new BigIntSerializerInterceptor());

  // Global API prefix (all routes become /api/*)
  app.setGlobalPrefix('api');

  // CORS — allow the web frontend origin
  app.enableCors({
    origin: config.TELECOM_HD_PUBLIC_URL,
    credentials: true,
  });

  // Swagger / OpenAPI documentation — disabled in production so the full API
  // surface (routes, auth schemes, request/response shapes) is not exposed.
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

  // Clean up Prisma / Redis / BullMQ on SIGTERM/SIGINT (graceful shutdown).
  app.enableShutdownHooks();

  const port = config.TELECOM_HD_API_PORT;
  await app.listen(port);

  app
    .get(Logger)
    .log(`API listening on :${port}${isProd ? '' : `   docs → http://localhost:${port}/api/docs`}`);
}

void bootstrap();
