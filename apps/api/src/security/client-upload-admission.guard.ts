import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { ClientPrincipal } from '../modules/client-auth/client-auth.service';
import { UploadAdmissionService } from './upload-admission.service';

/** Runs after ClientAuthGuard and before Multer for verified-client uploads. */
@Injectable()
export class ClientUploadAdmissionGuard implements CanActivate {
  constructor(private readonly admission: UploadAdmissionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { client?: ClientPrincipal }>();
    if (!request.client) throw new UnauthorizedException('Client session required');
    const bytes = this.admission.validateContentLength(request, 'client');
    await this.admission.reserve(request, bytes, 'client', String(request.client.userId));
    return true;
  }
}
