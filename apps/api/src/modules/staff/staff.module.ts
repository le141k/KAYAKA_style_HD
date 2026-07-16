import { Module } from '@nestjs/common';
import { StaffService } from './staff.service';
import { StaffController } from './staff.controller';
import { RbacAuditService } from './rbac-audit.service';

@Module({
  controllers: [StaffController],
  providers: [StaffService, RbacAuditService],
  exports: [StaffService, RbacAuditService],
})
export class StaffModule {}
