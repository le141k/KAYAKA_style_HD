import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { WORKFLOW_CHANGED_EVENT } from './workflow.executor';
import type { Workflow, Macro, MacroCategory } from '@prisma/client';
import type {
  CreateWorkflowDto,
  UpdateWorkflowDto,
  CreateMacroCategoryDto,
  UpdateMacroCategoryDto,
  CreateMacroDto,
  UpdateMacroDto,
} from './dto';

@Injectable()
export class WorkflowService {
  private readonly logger = new Logger(WorkflowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /** C3: tell the WorkflowExecutor to drop its cached enabled-workflows list. */
  private emitWorkflowChanged(): void {
    this.events.emit(WORKFLOW_CHANGED_EVENT);
  }

  // ─────────────────── Workflow CRUD ───────────────────

  async listWorkflows(): Promise<Workflow[]> {
    return this.prisma.workflow.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  }

  async getWorkflow(id: number): Promise<Workflow> {
    const w = await this.prisma.workflow.findUnique({ where: { id } });
    if (!w) throw new NotFoundException(`Workflow ${id} not found`);
    return w;
  }

  async createWorkflow(dto: CreateWorkflowDto): Promise<Workflow> {
    const created = await this.prisma.workflow.create({
      data: {
        title: dto.title,
        criteria: dto.criteria as object,
        actions: dto.actions as object,
        isEnabled: dto.isEnabled,
        sortOrder: dto.sortOrder,
      },
    });
    this.emitWorkflowChanged();
    return created;
  }

  async updateWorkflow(id: number, dto: UpdateWorkflowDto): Promise<Workflow> {
    await this.getWorkflow(id);
    const updated = await this.prisma.workflow.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.criteria !== undefined && { criteria: dto.criteria as object }),
        ...(dto.actions !== undefined && { actions: dto.actions as object }),
        ...(dto.isEnabled !== undefined && { isEnabled: dto.isEnabled }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      },
    });
    this.emitWorkflowChanged();
    return updated;
  }

  async deleteWorkflow(id: number): Promise<void> {
    await this.getWorkflow(id);
    await this.prisma.workflow.delete({ where: { id } });
    this.emitWorkflowChanged();
  }

  // ─────────────────── MacroCategory CRUD ───────────────────

  async listMacroCategories(): Promise<MacroCategory[]> {
    return this.prisma.macroCategory.findMany({ include: { macros: true } });
  }

  async getMacroCategory(id: number): Promise<MacroCategory> {
    const c = await this.prisma.macroCategory.findUnique({ where: { id }, include: { macros: true } });
    if (!c) throw new NotFoundException(`MacroCategory ${id} not found`);
    return c;
  }

  async createMacroCategory(dto: CreateMacroCategoryDto): Promise<MacroCategory> {
    return this.prisma.macroCategory.create({ data: dto });
  }

  async updateMacroCategory(id: number, dto: UpdateMacroCategoryDto): Promise<MacroCategory> {
    await this.getMacroCategory(id);
    return this.prisma.macroCategory.update({ where: { id }, data: dto });
  }

  async deleteMacroCategory(id: number): Promise<void> {
    await this.getMacroCategory(id);
    await this.prisma.macroCategory.delete({ where: { id } });
  }

  // ─────────────────── Macro CRUD ───────────────────

  async listMacros(categoryId?: number): Promise<Macro[]> {
    return this.prisma.macro.findMany({
      where: categoryId !== undefined ? { categoryId } : {},
      include: { category: true },
    });
  }

  /** Minimal macro list (id + title) for the ticket apply-macro picker. */
  listMacroOptions() {
    return this.prisma.macro.findMany({
      select: { id: true, title: true },
      orderBy: { title: 'asc' },
    });
  }

  async getMacro(id: number): Promise<Macro> {
    const m = await this.prisma.macro.findUnique({ where: { id } });
    if (!m) throw new NotFoundException(`Macro ${id} not found`);
    return m;
  }

  async createMacro(dto: CreateMacroDto): Promise<Macro> {
    return this.prisma.macro.create({
      data: {
        title: dto.title,
        replyText: dto.replyText,
        actions: dto.actions as object,
        isShared: dto.isShared ?? true,
        categoryId: dto.categoryId ?? null,
      },
    });
  }

  async updateMacro(id: number, dto: UpdateMacroDto): Promise<Macro> {
    await this.getMacro(id);
    return this.prisma.macro.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.replyText !== undefined && { replyText: dto.replyText }),
        ...(dto.actions !== undefined && { actions: dto.actions as object }),
        ...(dto.isShared !== undefined && { isShared: dto.isShared }),
        ...(dto.categoryId !== undefined && { categoryId: dto.categoryId }),
      },
    });
  }

  async deleteMacro(id: number): Promise<void> {
    await this.getMacro(id);
    await this.prisma.macro.delete({ where: { id } });
  }
}
