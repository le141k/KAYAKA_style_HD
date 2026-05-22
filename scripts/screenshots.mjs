// Captures key-screen screenshots of all three interfaces into docs/screenshots/.
// Requires api (4000) + web dev (3000) running. Run: node scripts/screenshots.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const WEB = 'http://localhost:3000';
const API = 'http://localhost:4000';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const shots = [
  ['login', '/login', false],
  ['client-kb', '/kb', false],
  ['client-submit', '/submit', false],
  ['staff-dashboard', '/staff/dashboard', true],
  ['staff-tickets', '/staff/tickets', true],
  ['staff-kanban', '/staff/kanban', true],
  ['staff-ticket-detail', '/staff/tickets/1', true],
  ['admin-sla', '/admin/sla', true],
  ['admin-alaris', '/admin/alaris', true],
];

const res = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@23telecom.example', password: 'demo1234' }),
});
const { accessToken } = await res.json();
console.log('token acquired:', !!accessToken);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript((t) => {
  try { localStorage.setItem('auth_token', t); } catch {}
}, accessToken);
await ctx.addCookies([{ name: 'auth_token', value: accessToken, url: WEB }]);

const page = await ctx.newPage();
for (const [name, path] of shots) {
  try {
    await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1500); // settle animations
    await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
    console.log('✓', name, path);
  } catch (e) {
    console.log('✗', name, path, String(e).split('\n')[0]);
  }
}
await browser.close();
console.log('done →', OUT);
