// Full smoke: staff + admin + client interfaces render REAL API data without crashing.
// Real demo login → walks each interface's key pages, captures console/page errors + screenshots.
import { chromium } from '@playwright/test';

const WEB = 'http://localhost:3000';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname.replace(/%20/g, ' ');

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

let ok = true;
async function check(label, path, expectText) {
  await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  const body = (await page.textContent('body')) ?? '';
  const crashed = body.includes('Application error') || body.includes('client-side exception');
  const hasExpected = expectText ? body.includes(expectText) : true;
  await page.screenshot({ path: `${OUT}verify-${label}.png`, fullPage: true });
  const status = crashed ? '✗ CRASH' : hasExpected ? '✓' : '? no-expected';
  console.log(`${status} ${label} ${path}` + (expectText ? ` (expect "${expectText}": ${hasExpected})` : ''));
  if (crashed || !hasExpected) ok = false;
  return !crashed && hasExpected;
}

// ── Real login (demo admin) ──────────────────────────────────────────────────
await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('#email', 'admin@23telecom.example');
await page.fill('#password', 'demo1234');
await page.click('button[type=submit]');
await page.waitForTimeout(3500);
console.log('after login URL:', page.url());

// ── STAFF ──────────────────────────────────────────────────────────────────
console.log('\n── STAFF ──');
await check('dashboard', '/staff/dashboard');
await check('tickets', '/staff/tickets', 'TT-');
await check('kanban', '/staff/kanban');
await check('ticket-detail', '/staff/tickets/1', 'TT-');

// ── ADMIN (demo user is admin) ───────────────────────────────────────────────
console.log('\n── ADMIN ──');
await check('admin-departments', '/admin/departments');
await check('admin-statuses', '/admin/statuses');
await check('admin-sla', '/admin/sla');
await check('admin-staff', '/admin/staff');
await check('admin-workflows', '/admin/workflows');
await check('admin-custom-fields', '/admin/custom-fields');

// ── CLIENT ───────────────────────────────────────────────────────────────────
console.log('\n── CLIENT ──');
// client "my tickets" reads requester email from localStorage.client_email
await page.addInitScript(() => localStorage.setItem('client_email', 'admin@23telecom.example'));
await check('client-tickets', '/tickets');
await check('client-submit', '/submit');
await check('client-kb', '/kb');

console.log('\nconsole/page errors:', errors.length ? errors.slice(0, 10) : 'none');
console.log(ok ? '\nFULL VERIFY: PASS' : '\nFULL VERIFY: ISSUES');
await browser.close();
process.exit(ok ? 0 : 1);
