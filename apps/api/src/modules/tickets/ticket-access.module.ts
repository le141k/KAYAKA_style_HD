import { Module } from '@nestjs/common';
import { TicketAccessPolicy } from './ticket-access-policy.service';

/** Shared, dependency-light module for staff ticket department isolation. */
@Module({
  providers: [TicketAccessPolicy],
  exports: [TicketAccessPolicy],
})
export class TicketAccessModule {}
