// Verifies the staff interface renders REAL API data without crashing.
// Real login flow → dashboard → tickets list → ticket detail. Screenshots + error capture.
import { chromium } from '@playwright/test';

const WEB = 'http://localhost:3000';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname.replace(/%20/g, ' ');

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

async function check(label, path, expectText) {
  await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  const body = await page.textContent('body');
  const crashed = body.includes('Application error') || body.includes('client-side exception');
  const hasExpected = expectText ? body.includes(expectText) : true;
  await page.screenshot({ path: `${OUT}verify-${label}.png`, fullPage: true });
  console.log(`${crashed ? '✗ CRASH' : hasExpected ? '✓' : '? no-expected'} ${label} ${path}` +
    (expectText ? ` (expect "${expectText}": ${hasExpected})` : ''));
  return !crashed && hasExpected;
}

// Real login flow
await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('#email', 'admin@23telecom.example');
await page.fill('#password', 'demo1234');
await page.click('button[type=submit]');
await page.waitForTimeout(3500);
console.log('after login URL:', page.url());

let ok = true;
ok = (await check('dashboard', '/staff/dashboard')) && ok;
ok = (await check('tickets', '/staff/tickets', 'TT-')) && ok;
ok = (await check('kanban', '/staff/kanban')) && ok;
ok = (await check('ticket-detail', '/staff/tickets/1', 'TT-')) && ok;

console.log('\nconsole/page errors:', errors.length ? errors.slice(0, 8) : 'none');
console.log(ok ? 'STAFF VERIFY: PASS' : 'STAFF VERIFY: ISSUES');
await browser.close();
