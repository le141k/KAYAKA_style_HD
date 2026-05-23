import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { RequirePermissions } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

const AddRecipientSchema = z.object({
  email: z.string().email(),
  role: z.enum(['CC', 'BCC']),
});
type AddRecipientDto = z.infer<typeof AddRecipientSchema>;

@ApiTags('tickets/recipients')
@Controller('tickets/:id/recipients')
@RequirePermissions(PERMISSIONS.TICKET_EDIT)
export class RecipientsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List CC/BCC recipients for a ticket' })
  list(@Param('id', ParseIntPipe) ticketId: number) {
    return this.prisma.ticketRecipient.findMany({
      where: { ticketId },
      orderBy: { addedAt: 'asc' },
    });
  }

  @Post()
  @ApiOperation({ summary: 'Add a CC or BCC recipient to a ticket (upsert)' })
  async add(
    @Param('id', ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(AddRecipientSchema)) dto: AddRecipientDto,
  ) {
    return this.prisma.ticketRecipient.upsert({
      where: { ticketId_email: { ticketId, email: dto.email } },
      create: { ticketId, email: dto.email, role: dto.role },
      update: { role: dto.role },
    });
  }

  @Delete(':email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a CC/BCC recipient from a ticket' })
  async remove(@Param('id', ParseIntPipe) ticketId: number, @Param('email') email: string) {
    await this.prisma.ticketRecipient.deleteMany({ where: { ticketId, email } });
  }
}
