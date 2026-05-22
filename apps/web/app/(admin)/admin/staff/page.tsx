import type { Metadata } from 'next';
import { StaffContent } from './staff-content';

export const metadata: Metadata = { title: 'Сотрудники и группы' };

export default function StaffPage() {
  return <StaffContent />;
}
