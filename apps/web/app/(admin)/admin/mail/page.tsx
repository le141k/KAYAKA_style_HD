import type { Metadata } from 'next';
import { MailContent } from './mail-content';

export const metadata: Metadata = { title: 'Почтовые очереди' };

export default function MailPage() {
  return <MailContent />;
}
