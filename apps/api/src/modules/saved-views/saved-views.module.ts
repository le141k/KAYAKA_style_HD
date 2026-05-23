import { Module } from '@nestjs/common';
import { SavedViewsController } from './saved-views.controller';
import { SavedViewsService } from './saved-views.service';

/** Saved ticket-list views, scoped per staff member. */
@Module({
  controllers: [SavedViewsController],
  providers: [SavedViewsService],
  exports: [SavedViewsService],
})
export class SavedViewsModule {}
