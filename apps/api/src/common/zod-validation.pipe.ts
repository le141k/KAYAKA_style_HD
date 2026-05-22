import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';

/** Validates/parses request payloads at the boundary with a Zod schema. */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    // When applied at method level via @UsePipes, NestJS runs the pipe against EVERY
    // handler argument — including custom params like @CurrentStaff and route @Param.
    // Only validate the actual request payloads; pass everything else through untouched.
    if (metadata.type !== 'body' && metadata.type !== 'query') {
      return value;
    }
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}
