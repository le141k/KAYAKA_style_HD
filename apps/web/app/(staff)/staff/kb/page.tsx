import type { Metadata } from 'next';
import { KBContent } from '../../../(client)/kb/kb-content';

export const metadata: Metadata = { title: 'База знаний' };

// Staff-scoped Knowledge Base — same content as the public /kb, but rendered
// inside the staff app shell (sidebar/topbar) so an agent never loses their
// workspace context. Links stay under /staff/kb.
export default function StaffKBPage() {
  return <KBContent basePath="/staff/kb" />;
}
