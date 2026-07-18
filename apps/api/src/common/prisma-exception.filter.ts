import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/**
 * Maps Prisma's known request errors to proper HTTP responses instead of
 * letting them bubble up as opaque 500s.
 *
 * - P2025 (record not found, e.g. update/delete/findUniqueOrThrow on a missing row) → 404
 * - P2003 (foreign-key constraint failed)                                           → 400
 * - P2002 (unique constraint violation)                                             → 409
 *
 * Anything else is rethrown to the default handler (still a 500), which is correct
 * for genuinely unexpected DB failures.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    switch (exception.code) {
      case 'P2025': {
        res.status(HttpStatus.NOT_FOUND).json({
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Resource not found',
          error: 'Not Found',
        });
        return;
      }
      case 'P2003': {
        const field = (exception.meta?.field_name as string | undefined) ?? 'reference';
        res.status(HttpStatus.BAD_REQUEST).json({
          statusCode: HttpStatus.BAD_REQUEST,
          message: `Invalid reference: ${field} does not exist`,
          error: 'Bad Request',
        });
        return;
      }
      case 'P2002': {
        const target = (exception.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
        res.status(HttpStatus.CONFLICT).json({
          statusCode: HttpStatus.CONFLICT,
          message: `Already exists: ${target} must be unique`,
          error: 'Conflict',
        });
        return;
      }
      default: {
        this.logger.error(`Unhandled Prisma error ${exception.code}`);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Internal server error',
          error: 'Internal Server Error',
        });
        return;
      }
    }
  }
}
