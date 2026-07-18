import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { ACCESS_COOKIE_PATH, authCookieNames, readCookie } from './auth.cookies';

const TOKEN_PART_RE = /^[0-9a-f]{64}$/;

/** Signed double-submit CSRF tokens. The readable cookie and request header must match. */
@Injectable()
export class CsrfService {
  private readonly signingKey: Buffer;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.signingKey = Buffer.from(
      hkdfSync('sha256', config.TELECOM_HD_JWT_ACCESS_SECRET, '', 'th-csrf-double-submit-v1', 32),
    );
  }

  createToken(): string {
    const nonce = randomBytes(32).toString('hex');
    return `${nonce}.${this.sign(nonce)}`;
  }

  issue(res: Response): string {
    // Reuse a valid token already stored on the API host. This matters when web
    // and API use separate hostnames: browser JS cannot read the API's host-only
    // cookie, so it bootstraps via GET /auth/csrf. Rotating on every bootstrap
    // would let overlapping mutations race (header A with a newly-set cookie B).
    const existing = this.cookieFromHeader(res.req.headers.cookie);
    const token = existing && this.isValid(existing, existing) ? existing : this.createToken();
    const names = authCookieNames(this.config);
    res.cookie(names.csrf, token, {
      httpOnly: false,
      secure: this.config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: ACCESS_COOKIE_PATH,
      maxAge: this.config.TELECOM_HD_JWT_REFRESH_TTL * 1000,
    });
    return token;
  }

  cookieFromHeader(header: string | undefined): string | undefined {
    return readCookie(header, authCookieNames(this.config).csrf);
  }

  isValid(cookieToken: string | undefined, headerToken: string | string[] | undefined): boolean {
    if (!cookieToken || typeof headerToken !== 'string' || cookieToken !== headerToken) return false;
    const [nonce, signature, extra] = cookieToken.split('.');
    if (
      extra !== undefined ||
      !nonce ||
      !signature ||
      !TOKEN_PART_RE.test(nonce) ||
      !TOKEN_PART_RE.test(signature)
    ) {
      return false;
    }
    const expected = Buffer.from(this.sign(nonce), 'hex');
    const actual = Buffer.from(signature, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private sign(nonce: string): string {
    return createHmac('sha256', this.signingKey).update(nonce).digest('hex');
  }
}
