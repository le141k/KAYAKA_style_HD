import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, UsePipes } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentStaff, Public, RequirePermissions, type AuthStaff } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { KnowledgebaseService } from './knowledgebase.service';
import {
  CreateArticleSchema,
  CreateCategorySchema,
  ListArticlesSchema,
  UpdateArticleSchema,
  type CreateArticleDto,
  type CreateCategoryDto,
  type ListArticlesDto,
  type UpdateArticleDto,
} from './dto';

@ApiTags('knowledgebase')
@Controller('kb')
export class KnowledgebaseController {
  constructor(private readonly kb: KnowledgebaseService) {}

  // ── public (client portal) ──
  @Public()
  @Get('articles')
  @ApiOperation({ summary: 'List/search knowledgebase articles' })
  @UsePipes(new ZodValidationPipe(ListArticlesSchema))
  list(@Query() query: ListArticlesDto) {
    // Public endpoint must always show published articles only (RBAC-1)
    return this.kb.listArticles({ ...query, publishedOnly: true });
  }

  @Public()
  @Get('articles/slug/:slug')
  @ApiOperation({ summary: 'Read a published article by slug (increments views)' })
  bySlug(@Param('slug') slug: string) {
    return this.kb.getArticleBySlug(slug);
  }

  @Public()
  @Get('categories')
  @ApiOperation({ summary: 'List knowledgebase categories' })
  categories() {
    // Public endpoint — published categories only (no draft leak).
    return this.kb.listCategories(true);
  }

  // ── staff/admin (manage) ──
  @RequirePermissions(PERMISSIONS.KB_VIEW)
  @Get('articles/:id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.kb.getArticle(id);
  }

  @RequirePermissions(PERMISSIONS.KB_VIEW)
  @Get('articles/:id/revisions')
  revisions(@Param('id', ParseIntPipe) id: number) {
    return this.kb.listRevisions(id);
  }

  @RequirePermissions(PERMISSIONS.KB_MANAGE)
  @Post('categories')
  @UsePipes(new ZodValidationPipe(CreateCategorySchema))
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.kb.createCategory(dto);
  }

  @RequirePermissions(PERMISSIONS.KB_MANAGE)
  @Post('articles')
  create(
    @Body(new ZodValidationPipe(CreateArticleSchema)) dto: CreateArticleDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.kb.createArticle(dto, staff.staffId);
  }

  @RequirePermissions(PERMISSIONS.KB_MANAGE)
  @Put('articles/:id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateArticleSchema)) dto: UpdateArticleDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.kb.updateArticle(id, dto, staff.staffId);
  }
}
