import type { Metadata } from 'next';
import { SlaContent } from './sla-content';

export const metadata: Metadata = { title: 'SLA-планы' };

export default function SLAPage() {
  return <SlaContent />;
}
