import { Module } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { TicketsController } from './tickets.controller';
import { ReferenceService } from './reference.service';
import { ReferenceController } from './reference.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [TicketsController, ReferenceController],
  providers: [TicketsService, ReferenceService],
  exports: [TicketsService],
})
export class TicketsModule {}
