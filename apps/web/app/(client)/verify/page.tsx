import type { Metadata } from 'next';
import { Suspense } from 'react';
import { VerifyContent } from './verify-content';

// referrer: no-referrer so the single-use login token (delivered in the URL fragment) can never
// leak via the Referer header to any resource this page loads (GOAL_PUBLIC_SECURITY S2-5).
export const metadata: Metadata = { title: 'Вход в портал', referrer: 'no-referrer' };

export default function VerifyPage() {
  return (
    <Suspense fallback={null}>
      <VerifyContent />
    </Suspense>
  );
}
