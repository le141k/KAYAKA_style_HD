import type { Metadata } from 'next';
import { WorkflowsContent } from './workflows-content';

export const metadata: Metadata = { title: 'Правила и макросы' };

export default function WorkflowsPage() {
  return <WorkflowsContent />;
}
