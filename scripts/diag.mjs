import { chromium } from '@playwright/test';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext();
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.stack || e.message));
await p.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
await p.fill('#email', 'admin@23telecom.example');
await p.fill('#password', 'demo1234');
await Promise.all([
  p.waitForURL('**/staff/**', { timeout: 45000 }),
  p.locator('form button[type="submit"]').click(),
]);
await p.goto('http://localhost:3000/staff/dashboard', { waitUntil: 'domcontentloaded', timeout: 45000 });
await p.waitForTimeout(4000);
const body = await p.textContent('body');
console.log('CRASHED:', body.includes('Application error') || body.includes('client-side exception'));
console.log('FIRST PAGEERROR:\n', errs[0] || 'none');
await b.close();
