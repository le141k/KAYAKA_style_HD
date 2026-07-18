import { z } from 'zod';
import { normalizeEmail } from '../../common/email.util';

const NormalizedEmailSchema = z.string().transform(normalizeEmail).pipe(z.string().email());

export const RequestLinkSchema = z.object({
  email: NormalizedEmailSchema,
  challengeToken: z.string().min(1).max(2048),
});
export type RequestLinkDto = z.infer<typeof RequestLinkSchema>;

export const VerifyClientSchema = z.object({ token: z.string().min(1) });
export type VerifyClientDto = z.infer<typeof VerifyClientSchema>;
