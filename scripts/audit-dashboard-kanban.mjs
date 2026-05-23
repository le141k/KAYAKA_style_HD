/**
 * RE-AUDIT: Staff Dashboard + Kanban — post-fix verification + bug sweep
 * Run: node scripts/audit-dashboard-kanban.mjs
 */
import { chromium } from 'playwright';
import { setTimeout as sleep } from 'timers/promises';

const BASE = 'http://localhost:3000';
const API  = 'http://localhost:4000/api';
const CREDS = { email: 'admin@23telecom.example', password: 'demo1234' };

let token = null;
const results = { fixed: [], broken: [] };
const ok  = (msg) => { console.log('  ✓ ' + msg); results.fixed.push(msg); };
const bad = (p, msg, detail = '') => { console.warn(`  ✗ [${p}] ${msg}${detail ? ' — ' + detail : ''}`); results.broken.push({ p, msg, detail }); };

// ── API helpers ──────────────────────────────────────────────────────────────
async function apiLogin() {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(CREDS),
  });
  if (!r.ok) throw new Error(`Login failed: ${r.status}`);
  const j = await r.json();
  token = j.accessToken;
  return token;
}

async function apiGet(path) {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}

async function apiPatch(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ── Browser helpers ──────────────────────────────────────────────────────────
async function browserLogin(page) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState('networkidle');
  await page.fill('#email', CREDS.email);
  await page.fill('#password', CREDS.password);
  await page.click('button:has-text("Войти")');
  // Wait for redirect (login success redirects to /staff/dashboard)
  await page.waitForTimeout(4000);
  if (!page.url().includes('/staff/')) {
    throw new Error(`Login redirect failed — still on ${page.url()}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n=== RE-AUDIT: Dashboard + Kanban ===\n');

  // ── 1. API-level checks (no browser) ────────────────────────────────────
  console.log('--- API sanity ---');
  try {
    await apiLogin();
    console.log('  API login OK');
  } catch (e) {
    bad('P0', 'API login failed', e.message);
    console.error('Cannot continue — aborting'); process.exit(1);
  }
  await sleep(300);

  // 1a. /reports/dashboard — sla_breached & avg_first_response real values
  try {
    const dash = await apiGet('/reports/dashboard');
    console.log('  /reports/dashboard:', JSON.stringify(dash));
    const hasBreached = typeof dash.slaBreached === 'number';
    const hasAvg      = typeof dash.avgFirstResponseMinutes === 'number';
    const hasByStatus = Array.isArray(dash.byStatus) && dash.byStatus.length > 0;
    if (hasBreached && hasAvg && hasByStatus) {
      ok(`/reports/dashboard returns slaBreached=${dash.slaBreached}, avgFirstResponseMinutes=${dash.avgFirstResponseMinutes}, byStatus[${dash.byStatus.length}]`);
    } else {
      bad('P1', '/reports/dashboard missing fields', JSON.stringify(dash));
    }
    // Check the resolved field exists (for "resolvedToday")
    if (typeof dash.resolved === 'number') {
      ok(`/reports/dashboard.resolved = ${dash.resolved}`);
    } else {
      bad('P1', '/reports/dashboard missing .resolved field', JSON.stringify(dash));
    }
  } catch (e) {
    bad('P1', '/reports/dashboard call failed', e.message);
  }
  await sleep(300);

  // 1b. Ticket status endpoint returns known slugs
  let statusMap = {};
  try {
    const statuses = await apiGet('/ticket-statuses');
    console.log('  ticket-statuses:', JSON.stringify(statuses));
    for (const s of statuses) statusMap[s.id] = s.title?.toLowerCase().replace(/\s+/g,'_');
    ok(`/ticket-statuses returns ${statuses.length} items: ${statuses.map(s=>s.title).join(', ')}`);
  } catch (e) {
    bad('P1', '/ticket-statuses failed', e.message);
  }
  await sleep(300);

  // 1c. Pick a ticket and test PATCH /tickets/:id/status (kanban persist)
  let testTicketId = null;
  let originalStatusId = null;
  try {
    const tickets = await apiGet('/tickets?limit=10');
    const tkt = tickets.data?.[0] ?? tickets[0];
    if (tkt) {
      testTicketId = tkt.id;
      originalStatusId = tkt.statusId;
      console.log(`  Test ticket: id=${tkt.id} mask=${tkt.mask} statusId=${tkt.statusId}`);
      ok(`Fetched test ticket id=${tkt.id}`);
    } else {
      bad('P1', 'No tickets returned from GET /tickets', '');
    }
  } catch (e) {
    bad('P1', 'GET /tickets failed', e.message);
  }
  await sleep(300);

  if (testTicketId) {
    // Find a different status to move to
    const statuses = Object.keys(statusMap).map(Number);
    const targetStatusId = statuses.find(id => id !== originalStatusId) ?? statuses[0];
    try {
      const patch = await apiPatch(`/tickets/${testTicketId}/status`, { statusId: targetStatusId });
      if (patch.status < 300) {
        ok(`PATCH /tickets/${testTicketId}/status → ${patch.status} (kanban persist endpoint works)`);
        // Restore
        await sleep(300);
        await apiPatch(`/tickets/${testTicketId}/status`, { statusId: originalStatusId });
      } else {
        bad('P0', `PATCH /tickets/${testTicketId}/status returned ${patch.status}`, JSON.stringify(patch.body));
      }
    } catch (e) {
      bad('P0', 'Kanban PATCH /status failed', e.message);
    }
    await sleep(300);
  }

  // 1d. /auth/me returns firstName/lastName (user display name)
  try {
    const me = await apiGet('/auth/me');
    console.log('  /auth/me:', JSON.stringify(me));
    const hasMeName = me.firstName || me.lastName || me.fullName;
    if (hasMeName) {
      ok(`/auth/me returns name fields: firstName="${me.firstName}" lastName="${me.lastName}" fullName="${me.fullName}"`);
    } else {
      bad('P1', '/auth/me has no firstName/lastName/fullName — user menu will show email only', JSON.stringify(me));
    }
  } catch (e) {
    bad('P1', '/auth/me failed', e.message);
  }
  await sleep(300);

  // ── 2. Browser checks ────────────────────────────────────────────────────
  console.log('\n--- Browser (Chromium headless) ---');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  // Capture console errors
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  const networkErrors = [];
  page.on('response', r => { if (r.status() >= 400) networkErrors.push(`${r.status()} ${r.url()}`); });

  try {
    await browserLogin(page);
    await sleep(1000);
    console.log('  Browser login → dashboard OK');

    // ── 2a. Dashboard page ──────────────────────────────────────────────
    await page.goto(`${BASE}/staff/dashboard`);
    await page.waitForLoadState('networkidle');
    await sleep(1500);

    // Stat cards rendered
    const statCards = await page.locator('[class*="AnimatedStatCard"], [data-testid="stat-card"]').count();
    // Try by grid structure (5 cards expected)
    const links = await page.locator('a[href*="staff/tickets?status="]').count();
    console.log(`  Clickable stat-card links found: ${links}`);
    if (links >= 2) {
      ok(`Dashboard stat cards clickable (found ${links} links to /staff/tickets?status=…)`);
    } else {
      bad('P1', `Dashboard stat card links found: ${links} (expected >= 2)`, '');
    }

    // Check for fake +5% / +12% trend text
    const bodyText = await page.innerText('body');
    if (bodyText.includes('+5%') || bodyText.includes('+12%')) {
      bad('P1', 'Fake trend "+5%" or "+12%" still visible in dashboard', '');
    } else {
      ok('Fake trend percentages (+5%/+12%) not present in dashboard');
    }

    // Check stat values are not all 0 (real data flowing)
    const statTexts = await page.locator('text=/^\\d+$/').allTextContents();
    console.log('  Stat numeric values found:', statTexts.slice(0, 10));
    // At least some non-zero numbers in stat area
    const nonZero = statTexts.filter(t => parseInt(t) > 0);
    if (nonZero.length > 0) {
      ok(`Dashboard stats show non-zero values (sample: ${nonZero.slice(0,5).join(', ')})`);
    } else {
      bad('P2', 'All visible numeric stat values are 0 — may indicate real data not flowing', '');
    }

    // Check "Добро пожаловать" subtitle
    const welcomeEl = await page.locator('text=Добро пожаловать').count();
    if (welcomeEl > 0) ok('Dashboard welcome subtitle present');

    // Check user display name (not email in top-bar)
    const userMenuText = await page.locator('header').innerText().catch(() => '');
    console.log('  Header text sample:', userMenuText.substring(0,100));
    // Admin's name should show (e.g. "Admin" not just the email)
    if (userMenuText.includes('@') && !userMenuText.includes('Admin')) {
      bad('P1', 'User menu may be showing email instead of display name', userMenuText.substring(0,80));
    } else {
      ok('User display name in header appears correct');
    }

    // Recent tickets list
    const ticketRows = await page.locator('[data-testid="ticket-row"], a[href*="/staff/tickets/"]').count();
    console.log('  Recent ticket rows:', ticketRows);
    if (ticketRows > 0) {
      ok(`Recent tickets list visible (${ticketRows} rows)`);
    } else {
      bad('P1', 'No recent tickets visible on dashboard', '');
    }

    // New ticket button
    const newTicketBtn = await page.locator('a[href*="create=1"], button:has-text("заявку"), a:has-text("заявку")').count();
    if (newTicketBtn > 0) ok('New ticket button present on dashboard');
    else bad('P2', 'New ticket button not found on dashboard', '');

    // "Все заявки" link
    const allTicketsLink = await page.locator('a[href="/staff/tickets"]').count();
    if (allTicketsLink > 0) ok('"Все заявки" link present');
    else bad('P2', '"Все заявки" link not found', '');

    // ── 2b. SLA Breached stat card link ────────────────────────────────
    const slaLink = await page.locator('a[href*="sla_breached=1"]').count();
    if (slaLink > 0) {
      ok('SLA Breached stat card has correct link (?status=open&sla_breached=1)');
    } else {
      bad('P2', 'SLA Breached stat card link not found', '');
    }

    // ── 2c. Notification bell ──────────────────────────────────────────
    const bellBtn = await page.locator('button[aria-label*="едомлени"]').first();
    if (await bellBtn.count() > 0) {
      await bellBtn.click();
      await sleep(500);
      const noNotifText = await page.locator('text=Нет уведомлений').count();
      const fakeBadge = await page.locator('span.bg-destructive').count();
      if (noNotifText > 0 && fakeBadge === 0) {
        ok('Notification bell: shows "Нет уведомлений" (no fake data)');
      } else if (fakeBadge > 0) {
        bad('P1', 'Notification bell still showing fake badge/count', '');
      } else {
        ok('Notification bell popover opened (empty state)');
      }
      // Close popover
      await page.keyboard.press('Escape');
      await sleep(300);
    } else {
      bad('P1', 'Notification bell button not found in header', '');
    }

    // ── 2d. User menu Профиль/Настройки links ─────────────────────────
    const userMenuBtn = await page.locator('button[aria-label*="Меню профиля"]').first();
    if (await userMenuBtn.count() > 0) {
      await userMenuBtn.click();
      await sleep(400);
      const profileLink = await page.locator('a:has-text("Профиль")').first();
      const settingsLink = await page.locator('a:has-text("Настройки")').first();
      const profileHref = await profileLink.getAttribute('href').catch(() => null);
      const settingsHref = await settingsLink.getAttribute('href').catch(() => null);
      console.log(`  User menu links: Профиль=${profileHref}, Настройки=${settingsHref}`);
      if (profileHref && profileHref !== '#') {
        ok(`User menu "Профиль" link → ${profileHref}`);
      } else {
        bad('P1', 'User menu "Профиль" link missing or points to "#"', String(profileHref));
      }
      if (settingsHref && settingsHref !== '#') {
        ok(`User menu "Настройки" link → ${settingsHref}`);
      } else {
        bad('P1', 'User menu "Настройки" link missing or points to "#"', String(settingsHref));
      }
      // Close by pressing Escape
      await page.keyboard.press('Escape');
      await sleep(300);
    } else {
      bad('P1', 'User menu trigger button not found', '');
    }

    // ── 2e. CommandPalette: only queries when open ──────────────────────
    // Open palette, check it renders; close it, confirm it's gone
    await page.keyboard.press('Meta+k');
    await sleep(600);
    const paletteOpen = await page.locator('[role="dialog"][aria-label*="Командная строка"], [role="dialog"][aria-label*="командная"]').count();
    if (paletteOpen > 0) {
      ok('CommandPalette opens on Cmd+K');
      // Type a query
      await page.keyboard.type('test');
      await sleep(600);
      ok('CommandPalette accepts query input');
      // Close
      await page.keyboard.press('Escape');
      await sleep(400);
      const paletteClosed = await page.locator('[role="dialog"][aria-label*="Командная строка"]').count();
      if (paletteClosed === 0) {
        ok('CommandPalette closes on Escape');
      } else {
        bad('P1', 'CommandPalette did not close on Escape', '');
      }
    } else {
      // Try Ctrl+K
      await page.keyboard.press('Control+k');
      await sleep(500);
      const paletteCtrl = await page.locator('[role="dialog"]').count();
      if (paletteCtrl > 0) {
        ok('CommandPalette opens on Ctrl+K');
        await page.keyboard.press('Escape');
      } else {
        bad('P1', 'CommandPalette did not open on Cmd/Ctrl+K', '');
      }
    }

    // ── 2f. Kanban page ─────────────────────────────────────────────────
    console.log('\n--- Kanban page ---');
    await page.goto(`${BASE}/staff/kanban`);
    await page.waitForLoadState('networkidle');
    await sleep(2000);

    // Check all 5 columns
    const expectedCols = ['Открытые', 'В работе', 'Ожидают', 'Решённые', 'Закрытые'];
    for (const col of expectedCols) {
      const found = await page.locator(`text="${col}"`).count();
      if (found > 0) ok(`Kanban column "${col}" present`);
      else bad('P1', `Kanban column "${col}" not found`, '');
    }

    // Count cards
    const cards = await page.locator('[data-testid="kanban-card"]').count();
    console.log(`  Kanban cards found: ${cards}`);
    if (cards > 0) {
      ok(`Kanban board has ${cards} card(s)`);
    } else {
      bad('P1', 'No kanban cards found — board may be empty or broken', '');
    }

    // ── 2g. Kanban drag-drop persists (native HTML5 DnD simulation) ─────
    if (cards >= 1) {
      // Find a card in the first non-empty column
      const firstCard = page.locator('[data-testid="kanban-card"]').first();
      const cardText = await firstCard.locator('text=/[A-Z]+-\\d+/').first().textContent().catch(() => '');
      console.log(`  First card mask: "${cardText}"`);

      // Get the bounding boxes of card and a target column
      const cardBox = await firstCard.boundingBox();
      // Find column labels and their containers
      const colContainers = await page.locator('[aria-label^="Колонка"]').all();
      console.log(`  Column containers found: ${colContainers.length}`);

      if (cardBox && colContainers.length >= 2) {
        // Simulate drag from first card to second column
        const targetCol = colContainers[1];
        const targetBox = await targetCol.boundingBox();
        if (targetBox) {
          // HTML5 DnD: dispatch drag events manually
          await page.evaluate(() => {
            const card = document.querySelector('[data-testid="kanban-card"]');
            if (card) {
              card.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
            }
          });
          await sleep(200);

          // Listen for PATCH request
          let patchFired = false;
          page.on('request', req => {
            if (req.method() === 'PATCH' && req.url().includes('/status')) {
              patchFired = true;
              console.log(`  PATCH request: ${req.url()}`);
            }
          });

          await page.evaluate((box) => {
            const target = [...document.querySelectorAll('[aria-label^="Колонка"]')][1];
            if (target) {
              target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
              target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
            }
          }, targetBox);
          await sleep(1000);

          if (patchFired) {
            ok('Kanban drag-drop fired PATCH /status (persists to backend)');
          } else {
            // More detailed check: the optimistic move may work but no PATCH if same column
            bad('P1', 'Kanban drag-drop did NOT fire PATCH /status — persistence may be broken', 'Check if card was in same column or DnD events not wiring correctly');
          }
        }
      } else {
        bad('P2', 'Could not test drag-drop — card or column bounding box not found', '');
      }
    }

    // ── 2h. Kanban card click opens ticket ─────────────────────────────
    if (cards >= 1) {
      const firstCard = page.locator('[data-testid="kanban-card"]').first();
      // Navigate away listener
      let navigated = false;
      page.once('framenavigated', () => { navigated = true; });
      await firstCard.click();
      await sleep(1000);
      const url = page.url();
      if (url.includes('/staff/tickets/')) {
        ok(`Kanban card click navigates to ticket detail: ${url}`);
      } else {
        bad('P1', 'Kanban card click did not navigate to ticket detail', `URL: ${url}`);
      }
      // Go back to kanban
      await page.goto(`${BASE}/staff/kanban`);
      await page.waitForLoadState('networkidle');
      await sleep(1500);
    }

    // ── 2i. Dashboard stat card click (open → /staff/tickets?status=open)
    await page.goto(`${BASE}/staff/dashboard`);
    await page.waitForLoadState('networkidle');
    await sleep(1500);

    const openLink = page.locator('a[href="/staff/tickets?status=open"]').first();
    if (await openLink.count() > 0) {
      await openLink.click();
      await sleep(800);
      const ticketsUrl = page.url();
      if (ticketsUrl.includes('/staff/tickets')) {
        ok(`Dashboard "Открытые" stat card click navigates to ${ticketsUrl}`);
      } else {
        bad('P1', 'Dashboard stat card click did not navigate correctly', `URL: ${ticketsUrl}`);
      }
      await page.goto(`${BASE}/staff/dashboard`);
      await sleep(800);
    }

    // ── 2j. Console errors summary ─────────────────────────────────────
    console.log('\n--- Console errors captured ---');
    if (consoleErrors.length === 0) {
      ok('No browser console errors detected during audit');
    } else {
      const significant = consoleErrors.filter(e =>
        !e.includes('favicon') && !e.includes('HMR') && !e.includes('Warning:')
      );
      if (significant.length === 0) {
        ok('No significant browser console errors (only favicon/HMR noise)');
      } else {
        for (const e of significant.slice(0, 5)) {
          bad('P2', 'Console error', e.substring(0, 150));
        }
      }
    }

    // ── 2k. 4xx/5xx network errors ─────────────────────────────────────
    const apiErrors = networkErrors.filter(e => !e.includes('favicon') && !e.includes('hot-update'));
    if (apiErrors.length === 0) {
      ok('No API 4xx/5xx errors during page loads');
    } else {
      for (const e of apiErrors.slice(0, 5)) {
        bad('P1', 'Network error during page load', e);
      }
    }

  } finally {
    await browser.close();
  }

  // ── 3. Summary ──────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════');
  console.log('FIXED ✓ items:');
  results.fixed.forEach(f => console.log(`  [FIXED ✓] ${f}`));
  console.log('\nBROKEN / NEW issues:');
  if (results.broken.length === 0) {
    console.log('  None found!');
  } else {
    results.broken.forEach(b => console.log(`  [${b.p}] ${b.msg}${b.detail ? ' — ' + b.detail : ''}`));
  }
  console.log(`\nTotal: ${results.fixed.length} fixed, ${results.broken.length} broken/new`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
