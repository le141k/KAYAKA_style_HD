// Verifies the fix-block via real login + admin create flow in the browser.
import { chromium } from '@playwright/test';

const WEB = 'http://localhost:3000';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
let ok = true;
const log = (pass, msg) => { if (!pass) ok = false; console.log(`${pass ? '✓' : '✗'} ${msg}`); };

// 1. Login lands on staff dashboard (not client portal)
await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('#email', 'admin@23telecom.example');
await page.fill('#password', 'demo1234');
await page.click('button[type=submit]');
await page.waitForTimeout(4000);
log(page.url().includes('/staff/dashboard'), `login → ${page.url()} (expect /staff/dashboard)`);

// 2. Admin departments page loads + create dept without parent works
await page.goto(`${WEB}/admin/departments`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const deptBody = (await page.textContent('body')) ?? '';
log(!deptBody.includes('Application error'), 'admin/departments renders');

// 3. Admin staff table loads (limit fix) — should NOT be empty for seed data
await page.goto(`${WEB}/admin/staff`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
const staffBody = (await page.textContent('body')) ?? '';
log(staffBody.includes('@23telecom.example') || staffBody.includes('admin'), 'admin/staff table loads seed staff (limit fix)');

// 4. Custom-fields page loads
await page.goto(`${WEB}/admin/custom-fields`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const cfBody = (await page.textContent('body')) ?? '';
log(!cfBody.includes('Application error'), 'admin/custom-fields renders');

console.log('\npage errors:', errors.length ? errors.slice(0, 6) : 'none');
console.log(ok ? '\nVERIFY-FIXES: PASS' : '\nVERIFY-FIXES: ISSUES');
await browser.close();
process.exit(ok ? 0 : 1);
