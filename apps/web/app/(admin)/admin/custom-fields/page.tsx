import type { Metadata } from 'next';
import { CustomFieldsContent } from './custom-fields-content';

export const metadata: Metadata = { title: 'Пользовательские поля' };

export default function CustomFieldsPage() {
  return <CustomFieldsContent />;
}
