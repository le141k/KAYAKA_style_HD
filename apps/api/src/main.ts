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

  const port = config.TELECOM_HD_API_PORT;
  await app.listen(port);

  app
    .get(Logger)
    .log(`API listening on :${port}${isProd ? '' : `   docs → http://localhost:${port}/api/docs`}`);
}

void bootstrap();
