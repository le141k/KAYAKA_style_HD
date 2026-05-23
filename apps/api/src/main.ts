import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Use Pino as the application-level logger (replaces NestJS default)
  app.useLogger(app.get(Logger));

  // Security headers (applies in dev + prod). The API is JSON-only behind a
  // reverse proxy in prod, so the strict default CSP is fine; we relax it just
  // enough for the self-hosted Swagger UI at /api/docs.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", "'unsafe-inline'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Global API prefix (all routes become /api/*)
  app.setGlobalPrefix('api');

  // CORS — allow the web frontend origin
  app.enableCors({
    origin: config.TELECOM_HD_PUBLIC_URL,
    credentials: true,
  });

  // Swagger / OpenAPI documentation
  const swaggerConfig = new DocumentBuilder()
    .setTitle('23 Telecom Help Desk API')
    .setDescription('NestJS 10 + Prisma + PostgreSQL helpdesk backend')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = config.TELECOM_HD_API_PORT;
  await app.listen(port);

  app.get(Logger).log(`API listening on :${port}   docs → http://localhost:${port}/api/docs`);
}

void bootstrap();
