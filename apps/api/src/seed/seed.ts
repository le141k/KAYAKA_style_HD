/**
 * Idempotent database seed for 23 Telecom Help Desk.
 * Run via: tsx src/seed/seed.ts
 *
 * Creates:
 *  - 2 StaffGroups (Administrator, Agent)
 *  - 2 Staff members (admin + agent)
 *  - 2 Departments (Support default, NOC)
 *  - 5 TicketStatuses
 *  - 4 TicketPriorities
 *  - 4 TicketTypes
 *  - 1 SlaPlan + SlaSchedule (Mon–Fri 09:00–18:00)
 *  - EmailTemplate rows including ticket_user_reply, autoresponder and auto-close,
 *    sla_breach_internal, notify_staff_assigned, notify_staff_user_replied,
 *    password_reset (en only)
 *  - 2 Organizations + 4 Users
 *  - 5 Demo tickets with posts
 */

import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { ALL_PERMISSIONS, ROLE_PRESETS } from '../auth/permissions';
import { seedReports } from './report-seeds';

const prisma = new PrismaClient();

async function hash(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

/** Find-or-create helper to keep seed idempotent without relying on specific IDs. */
async function findOrCreateWhere<T extends { id: number }>(
  findFn: () => Promise<T | null>,
  createFn: () => Promise<T>,
): Promise<T> {
  return (await findFn()) ?? (await createFn());
}

async function main(): Promise<void> {
  // The seed creates a demo admin (admin@23telecom.example / demo1234). In
  // production we REFUSE outright (loud, non-zero exit — not a silent skip) so a
  // known-password account can never be created on a real deployment. An operator
  // who really wants demo data must opt in explicitly with TELECOM_HD_SEED=1.
  if (process.env.NODE_ENV === 'production' && process.env.TELECOM_HD_SEED !== '1') {
    console.error(
      '⛔ Refusing to seed in production: this would create the demo admin ' +
        '(admin@23telecom.example / demo1234). Set TELECOM_HD_SEED=1 to override (NOT recommended).',
    );
    process.exit(1);
  }

  console.log('🌱 Seeding 23 Telecom Help Desk…');

  // ─────────────────── Staff Groups ───────────────────

  const adminGroup = await findOrCreateWhere(
    () => prisma.staffGroup.findFirst({ where: { title: 'Administrator' } }),
    () =>
      prisma.staffGroup.create({
        data: { title: 'Administrator', isAdmin: true, permissions: ALL_PERMISSIONS },
      }),
  );
  await prisma.staffGroup.update({
    where: { id: adminGroup.id },
    data: { isAdmin: true, permissions: ALL_PERMISSIONS },
  });

  const managerGroup = await findOrCreateWhere(
    () => prisma.staffGroup.findFirst({ where: { title: 'Manager' } }),
    () =>
      prisma.staffGroup.create({
        data: { title: 'Manager', isAdmin: false, permissions: ROLE_PRESETS.manager },
      }),
  );

  const agentGroup = await findOrCreateWhere(
    () => prisma.staffGroup.findFirst({ where: { title: 'Agent' } }),
    () =>
      prisma.staffGroup.create({ data: { title: 'Agent', isAdmin: false, permissions: ROLE_PRESETS.agent } }),
  );

  console.log(
    `  StaffGroups: Administrator (id=${adminGroup.id}), Manager (id=${managerGroup.id}), Agent (id=${agentGroup.id})`,
  );

  // ─────────────────── Staff Members ───────────────────

  const adminHash = await hash('demo1234');
  const agentHash = await hash('demo1234');

  const adminStaff = await prisma.staff.upsert({
    where: { email: 'admin@23telecom.example' },
    create: {
      email: 'admin@23telecom.example',
      username: 'admin',
      firstName: 'Admin',
      lastName: 'Telecom',
      passwordHash: adminHash,
      designation: 'System Administrator',
      staffGroupId: adminGroup.id,
    },
    update: { staffGroupId: adminGroup.id },
  });

  const managerHash = await hash('demo1234');
  const managerStaff = await prisma.staff.upsert({
    where: { email: 'manager@23telecom.example' },
    create: {
      email: 'manager@23telecom.example',
      username: 'manager1',
      firstName: 'Maria',
      lastName: 'Petrenko',
      passwordHash: managerHash,
      designation: 'Support Manager',
      staffGroupId: managerGroup.id,
    },
    update: { staffGroupId: managerGroup.id },
  });

  const agentStaff = await prisma.staff.upsert({
    where: { email: 'agent@23telecom.example' },
    create: {
      email: 'agent@23telecom.example',
      username: 'agent1',
      firstName: 'Alex',
      lastName: 'Ivanov',
      passwordHash: agentHash,
      designation: 'Support Agent',
      staffGroupId: agentGroup.id,
    },
    update: { staffGroupId: agentGroup.id },
  });

  console.log(`  Staff: ${adminStaff.email}, ${managerStaff.email}, ${agentStaff.email}`);

  // ─────────────────── Departments ───────────────────

  const supportDept = await findOrCreateWhere(
    () => prisma.department.findFirst({ where: { title: 'Support' } }),
    () => prisma.department.create({ data: { title: 'Support', isDefault: true, displayOrder: 0 } }),
  );

  const nocDept = await findOrCreateWhere(
    () => prisma.department.findFirst({ where: { title: 'NOC' } }),
    () => prisma.department.create({ data: { title: 'NOC', isDefault: false, displayOrder: 1 } }),
  );

  console.log(
    `  Departments: ${supportDept.title} (id=${supportDept.id}), ${nocDept.title} (id=${nocDept.id})`,
  );

  // ─────────────────── Ticket Statuses ───────────────────

  const statusDefs = [
    {
      title: 'Open',
      isDefault: true,
      markAsResolved: false,
      color: '#ffffff',
      bgColor: '#22c55e',
      displayOrder: 0,
    },
    {
      title: 'Pending',
      isDefault: false,
      markAsResolved: false,
      color: '#ffffff',
      bgColor: '#f59e0b',
      displayOrder: 1,
    },
    {
      title: 'In Progress',
      isDefault: false,
      markAsResolved: false,
      color: '#ffffff',
      bgColor: '#3b82f6',
      displayOrder: 2,
    },
    {
      title: 'Resolved',
      isDefault: false,
      markAsResolved: true,
      color: '#ffffff',
      bgColor: '#6b7280',
      displayOrder: 3,
    },
    {
      title: 'Closed',
      isDefault: false,
      markAsResolved: true,
      color: '#ffffff',
      bgColor: '#374151',
      displayOrder: 4,
    },
  ];

  const seededStatuses: Array<{ id: number; title: string }> = [];
  for (const def of statusDefs) {
    const existing = await prisma.ticketStatus.findFirst({ where: { title: def.title } });
    const s = existing
      ? await prisma.ticketStatus.update({ where: { id: existing.id }, data: def })
      : await prisma.ticketStatus.create({ data: def });
    seededStatuses.push(s);
  }

  const defaultStatus = seededStatuses.find((s) => s.title === 'Open')!;
  console.log(`  TicketStatuses: ${seededStatuses.map((s) => s.title).join(', ')}`);

  // ─────────────────── Ticket Priorities ───────────────────

  const priorityDefs = [
    { title: 'Low', displayOrder: 0, color: '#374151', bgColor: '#f3f4f6' },
    { title: 'Normal', displayOrder: 1, color: '#374151', bgColor: '#dbeafe' },
    { title: 'High', displayOrder: 2, color: '#ffffff', bgColor: '#f59e0b' },
    { title: 'Urgent', displayOrder: 3, color: '#ffffff', bgColor: '#ef4444' },
  ];

  const seededPriorities: Array<{ id: number; title: string }> = [];
  for (const def of priorityDefs) {
    const existing = await prisma.ticketPriority.findFirst({ where: { title: def.title } });
    const p = existing
      ? await prisma.ticketPriority.update({ where: { id: existing.id }, data: def })
      : await prisma.ticketPriority.create({ data: def });
    seededPriorities.push(p);
  }

  const normalPriority = seededPriorities.find((p) => p.title === 'Normal')!;
  const highPriority = seededPriorities.find((p) => p.title === 'High')!;
  const urgentPriority = seededPriorities.find((p) => p.title === 'Urgent')!;
  console.log(`  TicketPriorities: ${seededPriorities.map((p) => p.title).join(', ')}`);

  // ─────────────────── Ticket Types ───────────────────

  const typeDefs = [
    { title: 'Issue', displayOrder: 0 },
    { title: 'Question', displayOrder: 1 },
    { title: 'Incident', displayOrder: 2 },
    { title: 'Alaris Incident', displayOrder: 3 },
  ];

  const seededTypes: Array<{ id: number; title: string }> = [];
  for (const def of typeDefs) {
    const existing = await prisma.ticketType.findFirst({ where: { title: def.title } });
    const t = existing
      ? await prisma.ticketType.update({ where: { id: existing.id }, data: def })
      : await prisma.ticketType.create({ data: def });
    seededTypes.push(t);
  }

  const issueType = seededTypes.find((t) => t.title === 'Issue')!;
  const incidentType = seededTypes.find((t) => t.title === 'Incident')!;
  const alarisType = seededTypes.find((t) => t.title === 'Alaris Incident')!;
  console.log(`  TicketTypes: ${seededTypes.map((t) => t.title).join(', ')}`);

  // ─────────────────── SLA Plan + Schedule ───────────────────

  const schedule = await findOrCreateWhere(
    () => prisma.slaSchedule.findFirst({ where: { title: 'Standard Business Hours' } }),
    () =>
      prisma.slaSchedule.create({
        data: {
          title: 'Standard Business Hours',
          workHours: {
            mon: [['09:00', '18:00']],
            tue: [['09:00', '18:00']],
            wed: [['09:00', '18:00']],
            thu: [['09:00', '18:00']],
            fri: [['09:00', '18:00']],
          },
        },
      }),
  );

  const slaPlan = await findOrCreateWhere(
    () => prisma.slaPlan.findFirst({ where: { title: 'Standard SLA' } }),
    () =>
      prisma.slaPlan.create({
        data: {
          title: 'Standard SLA',
          isEnabled: true,
          firstResponseSeconds: 4 * 3600,
          resolutionSeconds: 24 * 3600,
          scheduleId: schedule.id,
        },
      }),
  );

  console.log(`  SLA: ${slaPlan.title} (schedule: ${schedule.title})`);

  // ─────────────────── Email Templates ───────────────────

  const templates = [
    {
      key: 'ticket_user_reply',
      locale: 'en',
      subject: 'Re: [{{mask}}] {{subject}}',
      htmlBody:
        '<p>Hello {{name}},</p><p>A new reply has been posted to your ticket <strong>{{mask}}</strong>: {{subject}}</p><p>{{contents}}</p><p>Best regards,<br>23 Telecom Support</p>',
      textBody:
        'Hello {{name}},\n\nA new reply to ticket {{mask}} ({{subject}}):\n\n{{contents}}\n\n23 Telecom Support',
    },
    {
      key: 'ticket_user_reply',
      locale: 'ru',
      subject: 'Ответ: [{{mask}}] {{subject}}',
      htmlBody:
        '<p>Здравствуйте, {{name}},</p><p>Получен новый ответ по тикету <strong>{{mask}}</strong>: {{subject}}</p><p>{{contents}}</p><p>С уважением,<br>Служба поддержки 23 Telecom</p>',
      textBody:
        'Здравствуйте, {{name}},\n\nНовый ответ по тикету {{mask}} ({{subject}}):\n\n{{contents}}\n\nСлужба поддержки 23 Telecom',
    },
    {
      key: 'autoresponder',
      locale: 'en',
      subject: '[{{mask}}] Your request has been received',
      htmlBody:
        '<p>Hello {{name}},</p><p>We have received your support request and assigned it ticket number <strong>{{mask}}</strong>.</p><p>Our team will respond within the next 4 business hours.</p><p>Best regards,<br>23 Telecom Support</p>',
      textBody:
        'Hello {{name}},\n\nYour request has been received ({{mask}}). We will respond within 4 business hours.\n\n23 Telecom Support',
    },
    {
      key: 'autoresponder',
      locale: 'ru',
      subject: '[{{mask}}] Ваш запрос получен',
      htmlBody:
        '<p>Здравствуйте, {{name}},</p><p>Ваше обращение зарегистрировано под номером <strong>{{mask}}</strong>.</p><p>Мы ответим в течение 4 рабочих часов.</p><p>С уважением,<br>Служба поддержки 23 Telecom</p>',
      textBody:
        'Здравствуйте, {{name}},\n\nВаш запрос зарегистрирован ({{mask}}). Ответим в течение 4 рабочих часов.\n\nСлужба поддержки 23 Telecom',
    },
    {
      key: 'ticket_auto_closed',
      locale: 'en',
      subject: '[{{mask}}] Your ticket has been closed',
      htmlBody:
        '<p>Hello {{name}},</p><p>Your ticket <strong>{{mask}}</strong> has been closed due to inactivity.</p><p>If you still need help, reply to this email to reopen it.</p><p>Best regards,<br>23 Telecom Support</p>',
      textBody:
        'Hello {{name}},\n\nYour ticket {{mask}} has been closed due to inactivity. If you still need help, reply to this email to reopen it.\n\n23 Telecom Support',
    },
    {
      key: 'sla_breach_internal',
      locale: 'en',
      subject: '[SLA BREACH] {{breachType}} — {{mask}} — {{minutesOverdue}}m overdue',
      htmlBody:
        '<p><strong>SLA Breach Alert</strong></p><p>Ticket <strong>{{mask}}</strong> has breached the {{breachType}} SLA target by {{minutesOverdue}} minutes.</p><p>Subject: {{subject}}</p><p>Rule: {{rule}}</p><p>Please take immediate action.</p>',
      textBody:
        'SLA BREACH\nTicket: {{mask}}\nType: {{breachType}}\nOverdue: {{minutesOverdue}}m\nSubject: {{subject}}\nRule: {{rule}}\n\nPlease take immediate action.',
    },
    {
      key: 'notify_staff_assigned',
      locale: 'en',
      subject: '[Assigned] {{mask}}: {{subject}}',
      htmlBody:
        '<p>Hello {{name}},</p><p>Ticket <strong>{{mask}}</strong> has been assigned to you.</p><p>Subject: {{subject}}</p><p>Please review and respond within your SLA window.</p><p>Best regards,<br>23 Telecom Help Desk</p>',
      textBody:
        'Hello {{name}},\n\nTicket {{mask}} has been assigned to you.\nSubject: {{subject}}\n\nPlease review and respond within your SLA window.\n\n23 Telecom Help Desk',
    },
    {
      key: 'notify_staff_user_replied',
      locale: 'en',
      subject: '[User Reply] {{mask}}: {{subject}}',
      htmlBody:
        '<p>Hello {{name}},</p><p>A customer has replied to ticket <strong>{{mask}}</strong>.</p><p>Subject: {{subject}}</p><p>Please review and respond as needed.</p><p>Best regards,<br>23 Telecom Help Desk</p>',
      textBody:
        'Hello {{name}},\n\nA customer has replied to ticket {{mask}}.\nSubject: {{subject}}\n\nPlease review and respond as needed.\n\n23 Telecom Help Desk',
    },
    {
      // Also provisioned in prod via migration 20260716000000_password_reset_template
      // (the prod seed does not run). Kept here so dev DBs match.
      key: 'password_reset',
      locale: 'en',
      subject: 'Reset your 23 Telecom Help Desk password',
      htmlBody:
        '<p>Hi {{firstName}},</p><p>We received a request to reset the password for your 23 Telecom Help Desk account. Choose a new password using the link below:</p><p><a href="{{resetUrl}}">Reset your password</a></p><p>This link expires in {{expiresInHours}} hour(s). If you did not request a password reset, you can safely ignore this email — your password will not change.</p>',
      textBody:
        'Hi {{firstName}},\n\nWe received a request to reset the password for your 23 Telecom Help Desk account.\nChoose a new password using the link below:\n\n{{resetUrl}}\n\nThis link expires in {{expiresInHours}} hour(s). If you did not request a password reset, you can safely ignore this email — your password will not change.',
    },
  ];

  for (const tpl of templates) {
    await prisma.emailTemplate.upsert({
      where: { key_locale: { key: tpl.key, locale: tpl.locale } },
      create: tpl,
      update: { subject: tpl.subject, htmlBody: tpl.htmlBody, textBody: tpl.textBody },
    });
  }
  console.log(`  EmailTemplates: ${templates.length} template versions`);

  // ─────────────────── Organizations ───────────────────

  const org1 = await findOrCreateWhere(
    () => prisma.organization.findFirst({ where: { name: 'Acme Corp' } }),
    () =>
      prisma.organization.create({
        data: {
          name: 'Acme Corp',
          city: 'Moscow',
          country: 'RU',
          phone: '+7 495 000-0001',
          slaPlanId: slaPlan.id,
        },
      }),
  );

  const org2 = await findOrCreateWhere(
    () => prisma.organization.findFirst({ where: { name: 'Beta LLC' } }),
    () =>
      prisma.organization.create({
        data: { name: 'Beta LLC', city: 'Saint Petersburg', country: 'RU', phone: '+7 812 000-0002' },
      }),
  );

  console.log(`  Organizations: ${org1.name}, ${org2.name}`);

  // ─────────────────── Users ───────────────────

  type UserSeed = { fullName: string; email: string; orgId: number | null };
  const usersData: UserSeed[] = [
    { fullName: 'Ivan Petrov', email: 'ivan.petrov@acme.example', orgId: org1.id },
    { fullName: 'Maria Sidorova', email: 'maria.s@acme.example', orgId: org1.id },
    { fullName: 'Dmitry Volkov', email: 'dvolkov@beta.example', orgId: org2.id },
    { fullName: 'Guest User', email: 'guest@external.example', orgId: null },
  ];

  const seededUsers: Array<{ id: number; fullName: string }> = [];
  for (const u of usersData) {
    const existingEmail = await prisma.userEmail.findUnique({ where: { email: u.email } });
    if (existingEmail) {
      seededUsers.push({ id: existingEmail.userId, fullName: u.fullName });
    } else {
      const created = await prisma.user.create({
        data: {
          fullName: u.fullName,
          organizationId: u.orgId,
          emails: { create: [{ email: u.email, isPrimary: true }] },
        },
      });
      seededUsers.push({ id: created.id, fullName: u.fullName });
    }
  }

  const [ivan, maria, dmitry] = seededUsers as [
    { id: number; fullName: string },
    { id: number; fullName: string },
    { id: number; fullName: string },
  ];

  console.log(`  Users: ${seededUsers.map((u) => u.fullName).join(', ')}`);

  // ─────────────────── Demo Tickets ───────────────────

  type TicketSeed = {
    subject: string;
    userId: number | null;
    email: string;
    name: string;
    priorityId: number;
    typeId: number;
    departmentId: number;
    ownerStaffId: number | null;
    body: string;
    creationMode: 'WEB' | 'ALARIS';
    creator: 'USER' | 'SYSTEM';
  };

  const ticketSeeds: TicketSeed[] = [
    {
      subject: 'Cannot connect to VPN',
      userId: ivan.id,
      email: 'ivan.petrov@acme.example',
      name: 'Ivan Petrov',
      priorityId: highPriority.id,
      typeId: incidentType.id,
      departmentId: supportDept.id,
      ownerStaffId: agentStaff.id,
      body: 'Since this morning I cannot connect to the corporate VPN. Error: connection timeout. Checked firewall — no changes. Please help ASAP.',
      creationMode: 'WEB',
      creator: 'USER',
    },
    {
      subject: 'Invoice #2024-112 — billing question',
      userId: maria.id,
      email: 'maria.s@acme.example',
      name: 'Maria Sidorova',
      priorityId: normalPriority.id,
      typeId: issueType.id,
      departmentId: supportDept.id,
      ownerStaffId: agentStaff.id,
      body: 'Hello, I received invoice #2024-112 but the amount does not match our contract. Could you clarify the line items?',
      creationMode: 'WEB',
      creator: 'USER',
    },
    {
      subject: 'Port 8443 blocked on transit link',
      userId: dmitry.id,
      email: 'dvolkov@beta.example',
      name: 'Dmitry Volkov',
      priorityId: urgentPriority.id,
      typeId: incidentType.id,
      departmentId: nocDept.id,
      ownerStaffId: agentStaff.id,
      body: 'Our monitoring shows port 8443 is being blocked on the upstream transit link AS23456. This is impacting production traffic. Need urgent investigation.',
      creationMode: 'WEB',
      creator: 'USER',
    },
    {
      subject: 'Request for static IP on circuit BT-0042',
      userId: ivan.id,
      email: 'ivan.petrov@acme.example',
      name: 'Ivan Petrov',
      priorityId: normalPriority.id,
      typeId: issueType.id,
      departmentId: supportDept.id,
      ownerStaffId: null,
      body: 'We would like to add a static IP block (/29) to our existing circuit BT-0042. Please advise on the process and timelines.',
      creationMode: 'WEB',
      creator: 'USER',
    },
    {
      subject: 'Alaris: high CPU on router R-MSK-01',
      userId: null,
      email: 'alaris@system.internal',
      name: 'Alaris Monitor',
      priorityId: highPriority.id,
      typeId: alarisType.id,
      departmentId: nocDept.id,
      ownerStaffId: null,
      body: 'Automated alert: CPU utilization on R-MSK-01 exceeded 90% for 5 consecutive minutes. Threshold: 85%. Interface: GigabitEthernet0/0.',
      creationMode: 'ALARIS',
      creator: 'SYSTEM',
    },
  ];

  let ticketIndex = 0;
  for (const ts of ticketSeeds) {
    ticketIndex++;
    const existingTicket = await prisma.ticket.findFirst({
      where: { subject: ts.subject, requesterEmail: ts.email },
    });
    if (existingTicket) {
      console.log(`  Ticket ${existingTicket.mask} (exists): ${ts.subject}`);
      continue;
    }

    // Create with a placeholder mask, then update
    const ticket = await prisma.ticket.create({
      data: {
        mask: 'TT-PENDING',
        subject: ts.subject,
        departmentId: ts.departmentId,
        statusId: defaultStatus.id,
        priorityId: ts.priorityId,
        typeId: ts.typeId,
        userId: ts.userId ?? undefined,
        requesterEmail: ts.email,
        requesterName: ts.name,
        ownerStaffId: ts.ownerStaffId ?? undefined,
        creationMode: ts.creationMode,
        creator: ts.creator,
        slaPlanId: slaPlan.id,
        totalReplies: 1,
        posts: {
          create: {
            authorType: ts.creator === 'SYSTEM' ? 'SYSTEM' : 'USER',
            userId: ts.userId ?? undefined,
            fullName: ts.name,
            email: ts.email,
            subject: ts.subject,
            contents: ts.body,
            isHtml: false,
            creationMode: ts.creationMode,
          },
        },
      },
    });

    const mask = `TT-${String(ticket.id).padStart(6, '0')}`;
    await prisma.ticket.update({ where: { id: ticket.id }, data: { mask } });

    // Add agent replies to first 2 tickets
    if (ticketIndex <= 2) {
      await prisma.ticketPost.create({
        data: {
          ticketId: ticket.id,
          authorType: 'STAFF',
          staffId: agentStaff.id,
          fullName: `${agentStaff.firstName} ${agentStaff.lastName}`,
          email: agentStaff.email,
          subject: `Re: ${ts.subject}`,
          contents:
            ticketIndex === 1
              ? 'Hello Ivan, we have escalated this to our network team. Please try reconnecting using the backup VPN gateway: vpn2.23telecom.example.'
              : 'Hello Maria, thank you for reaching out. We are reviewing invoice #2024-112 and will come back to you within 1 business day.',
          isHtml: false,
          creationMode: 'STAFF',
        },
      });
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { totalReplies: 2, lastReplyAt: new Date(), firstResponseAt: new Date() },
      });
    }

    console.log(`  Ticket ${mask}: ${ts.subject}`);
  }

  // ── Knowledgebase (categories + articles) ──
  const kbCats: Array<{ title: string; displayOrder: number }> = [
    { title: 'Техническая поддержка', displayOrder: 1 },
    { title: 'Подключение и настройка', displayOrder: 2 },
    { title: 'Биллинг', displayOrder: 3 },
  ];
  const kbCatId: Record<string, number> = {};
  for (const c of kbCats) {
    let cat = await prisma.kbCategory.findFirst({ where: { title: c.title } });
    if (!cat) cat = await prisma.kbCategory.create({ data: { ...c, isPublished: true } });
    kbCatId[c.title] = cat.id;
  }
  const kbArticles: Array<{ title: string; cat: string; html: string }> = [
    {
      title: 'Настройка PPPoE-подключения',
      cat: 'Подключение и настройка',
      html: '<p>Пошаговая настройка PPPoE: укажите логин и пароль из договора, MTU 1492. После сохранения переподключите интерфейс.</p>',
    },
    {
      title: 'Как сбросить VPN-подключение',
      cat: 'Техническая поддержка',
      html: '<p>Перезапустите VPN-клиент и переподключитесь к резервному шлюзу vpn2.23telecom.example.</p>',
    },
    {
      title: 'Вопросы по счёту и оплате',
      cat: 'Биллинг',
      html: '<p>Счета формируются ежемесячно. Оплатить можно в личном кабинете или по реквизитам из договора.</p>',
    },
  ];
  for (const a of kbArticles) {
    const existing = await prisma.kbArticle.findFirst({ where: { title: a.title } });
    if (!existing) {
      const slug = a.title
        .toLowerCase()
        .replace(/[^a-z0-9а-яё]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
      await prisma.kbArticle.create({
        data: {
          title: a.title,
          slug,
          contents: a.html,
          contentsText: a.html
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
          isPublished: true,
          categoryId: kbCatId[a.cat],
        },
      });
    }
  }
  console.log('  Knowledgebase: 3 categories, 3 articles');

  // ── Reports (P0: R-01..R-06 + P1: R-07..R-10) ──
  console.log('  Seeding reports...');
  await seedReports(prisma);
  console.log('  Reports: 10 canonical reports seeded');

  console.log('\n✅ Seed complete.');
}

main()
  .catch((err: unknown) => {
    console.error('Seed error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
