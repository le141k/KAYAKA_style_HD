import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ResetPasswordContent } from './reset-password-content';

export const metadata: Metadata = { title: 'Сброс пароля' };

export default function ResetPasswordPage() {
  // useSearchParams() in the content component requires a Suspense boundary
  // for static prerender (Next 15 CSR-bailout rule).
  return (
    <Suspense fallback={null}>
      <ResetPasswordContent />
    </Suspense>
  );
}
