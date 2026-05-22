import type { Metadata } from 'next';
import { StatusesContent } from './statuses-content';

export const metadata: Metadata = { title: 'Статусы и приоритеты' };

export default function StatusesPage() {
  return <StatusesContent />;
}
