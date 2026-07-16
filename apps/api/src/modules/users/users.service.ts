import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminService } from '../admin/admin.service';
import { normalizeEmail } from '../../common/email.util';
import type { CreateUserDto, UpdateUserDto, ListUsersQueryDto, AddEmailDto } from './dto';
import type { User, UserEmail } from '@prisma/client';

export type UserWithEmails = User & { emails: UserEmail[] };

/** Safe user — strips passwordHash. */
export type SafeUser = Omit<User, 'passwordHash'> & { emails: UserEmail[] };

const SAFE_USER_SELECT = {
  id: true,
  kayakoId: true,
  fullName: true,
  phone: true,
  designation: true,
  isEnabled: true,
  isValidated: true,
  timezone: true,
  userGroupId: true,
  organizationId: true,
  geoip: true,
  customFields: true,
  createdAt: true,
  updatedAt: true,
  emails: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminService: AdminService,
  ) {}

  async list(query: ListUsersQueryDto): Promise<{ data: SafeUser[]; total: number }> {
    const { page, limit, search, organizationId, email } = query;

    const where = {
      ...(organizationId !== undefined && { organizationId }),
      ...(email && {
        emails: { some: { email: { equals: email, mode: 'insensitive' as const } } },
      }),
      ...(search && {
        OR: [
          { fullName: { contains: search, mode: 'insensitive' as const } },
          { emails: { some: { email: { contains: search, mode: 'insensitive' as const } } } },
          { phone: { contains: search } },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: SAFE_USER_SELECT,
        orderBy: { id: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data, total };
  }

  async get(id: number): Promise<SafeUser> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: SAFE_USER_SELECT,
    });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    user.customFields = (await this.adminService.decryptCustomFields(
      'USER',
      user.customFields as Record<string, unknown>,
    )) as object;
    return user;
  }

  /**
   * Find a user by email address (searches UserEmail table).
   * Returns null if not found — used internally by ticket create flow.
   */
  async findByEmail(email: string): Promise<SafeUser | null> {
    // S2-2: look up by the normalized address so case/whitespace variants resolve to the
    // same owner (stored UserEmail rows are normalized on write + by the S2-2 migration).
    const userEmail = await this.prisma.userEmail.findUnique({
      where: { email: normalizeEmail(email) },
      include: { user: { select: SAFE_USER_SELECT } },
    });
    return userEmail?.user ?? null;
  }

  /**
   * Find or create a user by email.
   * Used by the ticket creation flow when only email/name is known.
   */
  async findOrCreate(email: string, fullName: string): Promise<SafeUser> {
    const normalized = normalizeEmail(email);
    const existing = await this.findByEmail(normalized);
    if (existing) return existing;

    try {
      return await this.prisma.user.create({
        data: {
          fullName,
          emails: {
            create: [{ email: normalized, isPrimary: true }],
          },
        },
        select: SAFE_USER_SELECT,
      });
    } catch (err) {
      // Concurrency: two requests for the same new email race to insert (UserEmail.email
      // is @unique → P2002). The loser re-reads the row the winner just created.
      if ((err as { code?: string }).code === 'P2002') {
        const created = await this.findByEmail(normalized);
        if (created) return created;
      }
      throw err;
    }
  }

  async create(dto: CreateUserDto): Promise<SafeUser> {
    // Validate + encrypt custom fields against USER scope definitions
    let cf = dto.customFields as Record<string, unknown> | undefined;
    if (cf && typeof cf === 'object') {
      await this.adminService.validateCustomFields('USER', cf);
      cf = await this.adminService.encryptCustomFields('USER', cf);
    }

    const { primaryEmail: rawPrimary, additionalEmails: rawAdditional, ...rest } = dto;
    // S2-2: normalize before the conflict check and insert so a case/whitespace variant of
    // an existing address is detected as a conflict (and stored consistently).
    const primaryEmail = normalizeEmail(rawPrimary);

    // Ensure primary email isn't already taken
    const conflict = await this.prisma.userEmail.findUnique({
      where: { email: primaryEmail },
    });
    if (conflict) throw new ConflictException(`Email ${primaryEmail} already in use`);

    const allEmails = [
      { email: primaryEmail, isPrimary: true },
      ...rawAdditional.map((e) => ({ email: normalizeEmail(e), isPrimary: false })),
    ];

    return this.prisma.user.create({
      data: {
        ...rest,
        ...(cf !== undefined ? { customFields: cf as object } : {}),
        emails: { create: allEmails },
      } as Parameters<typeof this.prisma.user.create>[0]['data'],
      select: SAFE_USER_SELECT,
    });
  }

  async update(id: number, dto: UpdateUserDto): Promise<SafeUser> {
    await this.get(id);

    // Validate + encrypt custom fields against USER scope definitions (if provided)
    let cf = dto.customFields as Record<string, unknown> | undefined;
    if (cf && typeof cf === 'object') {
      await this.adminService.validateCustomFields('USER', cf);
      cf = await this.adminService.encryptCustomFields('USER', cf);
    }

    return this.prisma.user.update({
      where: { id },
      data: {
        ...dto,
        ...(cf !== undefined ? { customFields: cf as object } : {}),
      } as Parameters<typeof this.prisma.user.update>[0]['data'],
      select: SAFE_USER_SELECT,
    });
  }

  async addEmail(userId: number, dto: AddEmailDto): Promise<UserEmail> {
    await this.get(userId);
    const email = normalizeEmail(dto.email); // S2-2: normalize before conflict check + insert
    const conflict = await this.prisma.userEmail.findUnique({ where: { email } });
    if (conflict) throw new ConflictException(`Email ${email} already in use`);

    if (dto.isPrimary) {
      // Demote existing primary
      await this.prisma.userEmail.updateMany({
        where: { userId, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    return this.prisma.userEmail.create({ data: { userId, ...dto, email } });
  }

  async removeEmail(userId: number, emailId: number): Promise<void> {
    const record = await this.prisma.userEmail.findFirst({
      where: { id: emailId, userId },
    });
    if (!record) throw new NotFoundException(`Email ${emailId} not found on user ${userId}`);
    if (record.isPrimary) {
      throw new ConflictException('Cannot remove primary email; set another email as primary first');
    }
    await this.prisma.userEmail.delete({ where: { id: emailId } });
  }

  async setPrimaryEmail(userId: number, emailId: number): Promise<void> {
    const record = await this.prisma.userEmail.findFirst({ where: { id: emailId, userId } });
    if (!record) throw new NotFoundException(`Email ${emailId} not found on user ${userId}`);

    await this.prisma.$transaction([
      this.prisma.userEmail.updateMany({
        where: { userId, isPrimary: true },
        data: { isPrimary: false },
      }),
      this.prisma.userEmail.update({ where: { id: emailId }, data: { isPrimary: true } }),
    ]);
  }
}
