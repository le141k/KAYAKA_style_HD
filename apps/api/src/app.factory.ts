import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { AppConfig } from './config/configuration';
import { BigIntSerializerInterceptor } from './common/bigint-serializer.interceptor';
import { inboundSecretMatches } from './common/inbound-secret.util';

/**
 * Register the PIPE ingress guard and parsers in the only safe order:
 * secret check first, then the route-specific large parser, followed by the
 * small global parser registered by `createApiApp`.  Exported separately so
 * HTTP-level tests exercise the exact production middleware order.
 */
export function configureInboundPipeMiddleware(
  app: Pick<express.Application, 'use'>,
  config: Pick<AppConfig, 'TELECOM_HD_INBOUND_WEBHOOK_SECRET' | 'TELECOM_HD_INBOUND_MAX_SIZE_MB'>,
): void {
  const inboundLimit = `${config.TELECOM_HD_INBOUND_MAX_SIZE_MB}mb`;
  app.use('/api/inbound/pipe', (req: Request, res: Response, next: NextFunction) => {
    const headerVal = req.headers['x-inbound-secret'];
    const provided = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    if (!inboundSecretMatches(provided, config.TELECOM_HD_INBOUND_WEBHOOK_SECRET)) {
      res.status(403).json({ statusCode: 403, message: 'Invalid inbound webhook secret' });
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
