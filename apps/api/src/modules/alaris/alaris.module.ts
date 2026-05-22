import { Module } from '@nestjs/common';
import { AlarisService } from './alaris.service';
import { AlarisController } from './alaris.controller';
import { TicketsModule } from '../tickets/tickets.module';
import { loadConfig, APP_CONFIG } from '../../config/configuration';

@Module({
  imports: [TicketsModule],
  controllers: [AlarisController],
  providers: [
    { provide: APP_CONFIG, useValue: loadConfig() },
    AlarisService,
  ],
  exports: [AlarisService],
})
export class AlarisModule {}
