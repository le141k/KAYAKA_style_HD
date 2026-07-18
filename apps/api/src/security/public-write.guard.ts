import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_CONFIG, AppConfig } from '../config/configuration';

export type PublicWriteFeature = 'ticket-create' | 'upload';
const PUBLIC_WRITE_FEATURE = 'public_write_feature';

export function PublicWrite(feature: PublicWriteFeature): ReturnType<typeof applyDecorators> {
  return applyDecorators(SetMetadata(PUBLIC_WRITE_FEATURE, feature), UseGuards(PublicWriteGuard));
}

/** Independent production kill switches: ticket creation and uploads are never opened together. */
@Injectable()
export class PublicWriteGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.config.NODE_ENV !== 'production') return true;
    const feature = this.reflector.get<PublicWriteFeature>(PUBLIC_WRITE_FEATURE, context.getHandler());
    const enabled =
      feature === 'ticket-create'
        ? this.config.TELECOM_HD_PUBLIC_TICKET_CREATE_ENABLED
        : feature === 'upload'
          ? this.config.TELECOM_HD_PUBLIC_UPLOAD_ENABLED
          : false;
    if (!enabled) throw new NotFoundException();
    return true;
  }
}
