import { Logger } from 'nestjs-pino';
import { loadConfig } from './config/configuration';
import { createApiApp } from './app.factory';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApiApp(config);

  const port = config.TELECOM_HD_API_PORT;
  await app.listen(port);

  app
    .get(Logger)
    .log(
      `API listening on :${port}${config.NODE_ENV === 'production' ? '' : `   docs → http://localhost:${port}/api/docs`}`,
    );
}

void bootstrap();
