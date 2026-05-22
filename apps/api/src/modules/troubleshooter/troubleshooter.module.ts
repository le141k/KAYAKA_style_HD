import { Body, Controller, Get, Injectable, Module, Param, ParseIntPipe, Post, UsePipes } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { Public, RequirePermissions } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';

const CategorySchema = z.object({ title: z.string().min(1), parentId: z.number().int().positive().optional(), displayOrder: z.number().int().default(0) });
const StepSchema = z.object({ categoryId: z.number().int().positive(), title: z.string().min(1), contents: z.string().min(1), displayOrder: z.number().int().default(0) });
const LinkSchema = z.object({ fromId: z.number().int().positive(), toId: z.number().int().positive(), label: z.string().default('') });

@Injectable()
export class TroubleshooterService {
  constructor(private readonly prisma: PrismaService) {}

  categories() {
    return this.prisma.troubleshooterCategory.findMany({ orderBy: { displayOrder: 'asc' } });
  }
  async tree(categoryId: number) {
    const steps = await this.prisma.troubleshooterStep.findMany({
      where: { categoryId },
      orderBy: { displayOrder: 'asc' },
      include: { linksFrom: true },
    });
    return steps;
  }
  createCategory(data: z.infer<typeof CategorySchema>) {
    return this.prisma.troubleshooterCategory.create({ data });
  }
  createStep(data: z.infer<typeof StepSchema>) {
    return this.prisma.troubleshooterStep.create({ data });
  }
  linkSteps(data: z.infer<typeof LinkSchema>) {
    return this.prisma.troubleshooterStepLink.create({ data });
  }
}

@ApiTags('troubleshooter')
@Controller('troubleshooter')
export class TroubleshooterController {
  constructor(private readonly ts: TroubleshooterService) {}

  @Public() @Get('categories') @ApiOperation({ summary: 'List troubleshooter categories' })
  categories() { return this.ts.categories(); }

  @Public() @Get('categories/:id/steps') @ApiOperation({ summary: 'Get step tree for a category' })
  tree(@Param('id', ParseIntPipe) id: number) { return this.ts.tree(id); }

  @RequirePermissions(PERMISSIONS.KB_MANAGE) @Post('categories') @UsePipes(new ZodValidationPipe(CategorySchema))
  createCategory(@Body() dto: z.infer<typeof CategorySchema>) { return this.ts.createCategory(dto); }

  @RequirePermissions(PERMISSIONS.KB_MANAGE) @Post('steps') @UsePipes(new ZodValidationPipe(StepSchema))
  createStep(@Body() dto: z.infer<typeof StepSchema>) { return this.ts.createStep(dto); }

  @RequirePermissions(PERMISSIONS.KB_MANAGE) @Post('links') @UsePipes(new ZodValidationPipe(LinkSchema))
  link(@Body() dto: z.infer<typeof LinkSchema>) { return this.ts.linkSteps(dto); }
}

@Module({
  controllers: [TroubleshooterController],
  providers: [TroubleshooterService],
  exports: [TroubleshooterService],
})
export class TroubleshooterModule {}
