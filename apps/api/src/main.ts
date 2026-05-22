import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Use Pino as the application-level logger (replaces NestJS default)
  app.useLogger(app.get(Logger));

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
