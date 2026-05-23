import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateEmailQueueDto, UpdateEmailQueueDto } from './dto';

/** Fields that are always omitted from responses (stored password). */
const SAFE_SELECT = {
  id: true,
  type: true,
  emailAddress: true,
  host: true,
  port: true,
  username: true,
  useTls: true,
  departmentId: true,
  signature: true,
  isEnabled: true,
  createdAt: true,
} as const;

@Injectable()
export class EmailQueueService {
  constructor(private readonly prisma: PrismaService) {}

  /** List all email queues (passwordEnc excluded). */
  list() {
    return this.prisma.emailQueue.findMany({
      select: SAFE_SELECT,
      orderBy: { id: 'asc' },
    });
  }

  /** Get a single email queue by ID (passwordEnc excluded). */
  async get(id: number) {
    const queue = await this.prisma.emailQueue.findUnique({
      where: { id },
      select: SAFE_SELECT,
    });
    if (!queue) throw new NotFoundException(`EmailQueue #${id} not found`);
    return queue;
  }

  /** Create a new email queue. The caller-supplied password is stored as passwordEnc
   *  (plain-text here; apply encryption before calling in production). */
  create(dto: CreateEmailQueueDto) {
    const { password, ...rest } = dto;
    return this.prisma.emailQueue.create({
      data: {
        ...rest,
        passwordEnc: password ?? '',
      },
      select: SAFE_SELECT,
    });
  }

  /** Update an existing email queue (partial). */
  async update(id: number, dto: UpdateEmailQueueDto) {
    await this.get(id); // throws NotFoundException when missing
    const { password, ...rest } = dto;
    const data: Record<string, unknown> = { ...rest };
    if (password !== undefined) {
      data.passwordEnc = password;
    }
    return this.prisma.emailQueue.update({
      where: { id },
      data,
      select: SAFE_SELECT,
    });
  }

  /** Delete an email queue. */
  async delete(id: number): Promise<void> {
    await this.get(id); // throws NotFoundException when missing
    await this.prisma.emailQueue.delete({ where: { id } });
  }
}
