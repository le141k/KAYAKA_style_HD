import { redirect } from 'next/navigation';

// The admin area has no standalone overview yet — send /admin to the first
// settings section. (Previously /admin had no page.tsx → 404 on the sidebar
// "Настройки" link and on every RSC prefetch.)
export default function AdminIndexPage() {
  redirect('/admin/departments');
}
