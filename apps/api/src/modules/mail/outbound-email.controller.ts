import { Controller, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentStaff, RequirePermissions, type AuthStaff } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { MailService } from './mail.service';

@ApiTags('admin/outbound-emails')
@Controller('admin/outbound-emails')
export class OutboundEmailController {
  constructor(private readonly mailService: MailService) {}

  @Post(':id/retry')
  @RequirePermissions(PERMISSIONS.ADMIN_MAIL)
  @ApiOperation({
    summary:
      'Retry a FAILED/AMBIGUOUS outbound email with its original SMTP Message-ID and immutable snapshot',
  })
  async retry(@Param('id') id: string, @CurrentStaff() staff: AuthStaff) {
    // CUIDs are opaque database ids. Do not expose a parser that incorrectly
    // assumes UUID format; the durable lookup below is the authority.
    if (!/^[a-z0-9]{10,64}$/i.test(id)) throw new NotFoundException(`Outbound email ${id} not found`);
    const status = await this.mailService.retryOutboundEmail(id, {
      staffId: staff.staffId,
      email: staff.email,
    });
    if (!status) throw new NotFoundException(`Outbound email ${id} is not retryable`);
    return status;
  }
}
