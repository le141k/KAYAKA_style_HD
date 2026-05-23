import type { Metadata } from 'next';
import { LoginScreen } from '@/components/premium/LoginScreen';

export const metadata: Metadata = { title: 'Вход' };

export default function LoginPage() {
  // /api/auth/login authenticates STAFF (admin + agent) only — end users use the
  // email-based portal, not this form. A successful login must land in the staff
  // workspace, not the client portal.
  return <LoginScreen redirectTo="/staff/dashboard" />;
}
