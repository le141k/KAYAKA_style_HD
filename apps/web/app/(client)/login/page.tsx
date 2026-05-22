import type { Metadata } from 'next';
import { LoginScreen } from '@/components/premium/LoginScreen';

export const metadata: Metadata = { title: 'Вход' };

export default function LoginPage() {
  return <LoginScreen redirectTo="/tickets" />;
}
