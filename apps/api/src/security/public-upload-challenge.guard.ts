import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { TurnstileService } from './turnstile.service';
import { UploadAdmissionService } from './upload-admission.service';

/** Validate the public-upload challenge before Multer starts reading multipart bytes. */
@Injectable()
export class PublicUploadChallengeGuard implements CanActivate {
  constructor(
    private readonly turnstile: TurnstileService,
    private readonly admission: UploadAdmissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const bytes = this.admission.validateContentLength(request, 'public');
    const rawToken = request.headers['x-turnstile-token'];
    const token = typeof rawToken === 'string' ? rawToken : undefined;
    await this.turnstile.verify(token, 'public-upload', request.ip);
    // Reserve only after a valid, single-use challenge. Multer has not run yet.
    await this.admission.reserve(request, bytes, 'public');
    return true;
  }
}
