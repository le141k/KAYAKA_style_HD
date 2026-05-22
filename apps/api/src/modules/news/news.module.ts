import { Body, Controller, Get, Injectable, Param, ParseIntPipe, Post, Put, Module } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentStaff, Public, RequirePermissions, type AuthStaff } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';

const NewsSchema = z.object({
  title: z.string().min(1),
  contents: z.string().min(1),
  isPublished: z.boolean().default(false),
});
type NewsDto = z.infer<typeof NewsSchema>;

@Injectable()
export class NewsService {
  constructor(private readonly prisma: PrismaService) {}

  listPublished() {
    return this.prisma.newsItem.findMany({ where: { isPublished: true }, orderBy: { publishedAt: 'desc' } });
  }
  listAll() {
    return this.prisma.newsItem.findMany({ orderBy: { createdAt: 'desc' } });
  }
  create(dto: NewsDto, authorStaffId?: number) {
    return this.prisma.newsItem.create({
      data: { ...dto, authorStaffId, publishedAt: dto.isPublished ? new Date() : null },
    });
  }
  update(id: number, dto: Partial<NewsDto>) {
    return this.prisma.newsItem.update({
      where: { id },
      data: { ...dto, ...(dto.isPublished ? { publishedAt: new Date() } : {}) },
    });
  }
}

@ApiTags('news')
@Controller('news')
export class NewsController {
  constructor(private readonly news: NewsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'List published news items' })
  published() {
    return this.news.listPublished();
  }

  @RequirePermissions(PERMISSIONS.NEWS_MANAGE)
  @Get('all')
  all() {
    return this.news.listAll();
  }

  @RequirePermissions(PERMISSIONS.NEWS_MANAGE)
  @Post()
  create(@Body(new ZodValidationPipe(NewsSchema)) dto: NewsDto, @CurrentStaff() staff: AuthStaff) {
    return this.news.create(dto, staff.staffId);
  }

  @RequirePermissions(PERMISSIONS.NEWS_MANAGE)
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(NewsSchema.partial())) dto: Partial<NewsDto>) {
    return this.news.update(id, dto);
  }
}

@Module({
  controllers: [NewsController],
  providers: [NewsService],
  exports: [NewsService],
})
export class NewsModule {}
