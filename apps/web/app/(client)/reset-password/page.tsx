import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ResetPasswordContent } from './reset-password-content';

// referrer: no-referrer so the reset token (delivered in the URL fragment) can never
// leak via the Referer header to any resource this page loads (GOAL_PUBLIC_SECURITY S1-5).
export const metadata: Metadata = { title: 'Сброс пароля', referrer: 'no-referrer' };

export default function ResetPasswordPage() {
  // useSearchParams() in the content component requires a Suspense boundary
  // for static prerender (Next 15 CSR-bailout rule).
  return (
    <Suspense fallback={null}>
      <ResetPasswordContent />
    </Suspense>
  );
}
