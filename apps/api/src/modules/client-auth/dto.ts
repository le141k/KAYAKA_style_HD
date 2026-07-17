import { z } from 'zod';

export const RequestLinkSchema = z.object({ email: z.string().email() });
export type RequestLinkDto = z.infer<typeof RequestLinkSchema>;

export const VerifyClientSchema = z.object({ token: z.string().min(1) });
export type VerifyClientDto = z.infer<typeof VerifyClientSchema>;
