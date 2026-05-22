-- CreateEnum
CREATE TYPE "DepartmentType" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "UserGroupType" AS ENUM ('GUEST', 'REGISTERED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('STAFF', 'USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "CreationMode" AS ENUM ('WEB', 'EMAIL', 'API', 'STAFF', 'ALARIS');

-- CreateEnum
CREATE TYPE "CustomFieldScope" AS ENUM ('TICKET', 'USER', 'STAFF', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'TEXTAREA', 'PASSWORD', 'CHECKBOX', 'RADIO', 'SELECT', 'MULTISELECT', 'DATE', 'FILE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "SlaTargetType" AS ENUM ('FIRST_RESPONSE', 'RESOLUTION');

-- CreateEnum
CREATE TYPE "EmailQueueType" AS ENUM ('IMAP', 'POP3', 'PIPE');

-- CreateEnum
CREATE TYPE "FlagType" AS ENUM ('NONE', 'PURPLE', 'ORANGE', 'GREEN', 'YELLOW', 'RED', 'BLUE');

-- CreateTable
CREATE TABLE "StaffGroup" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Staff" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "designation" TEXT NOT NULL DEFAULT '',
    "signature" TEXT NOT NULL DEFAULT '',
    "mobileNumber" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "staffGroupId" INTEGER NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "staffId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserGroup" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "type" "UserGroupType" NOT NULL DEFAULT 'REGISTERED',
    "isMaster" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "postalCode" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "slaPlanId" INTEGER,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "designation" TEXT NOT NULL DEFAULT '',
    "passwordHash" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isValidated" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "userGroupId" INTEGER,
    "organizationId" INTEGER,
    "geoip" JSONB,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserEmail" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "UserEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "type" "DepartmentType" NOT NULL DEFAULT 'PUBLIC',
    "app" TEXT NOT NULL DEFAULT 'tickets',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "parentId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartmentStaff" (
    "departmentId" INTEGER NOT NULL,
    "staffId" INTEGER NOT NULL,

    CONSTRAINT "DepartmentStaff_pkey" PRIMARY KEY ("departmentId","staffId")
);

-- CreateTable
CREATE TABLE "TicketStatus" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "markAsResolved" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT NOT NULL DEFAULT '',
    "bgColor" TEXT NOT NULL DEFAULT '',
    "displayIcon" TEXT NOT NULL DEFAULT '',
    "triggersSurvey" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TicketStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketPriority" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "color" TEXT NOT NULL DEFAULT '',
    "bgColor" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "TicketPriority_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketType" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "displayIcon" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "TicketType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" SERIAL NOT NULL,
    "mask" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "departmentId" INTEGER NOT NULL,
    "statusId" INTEGER NOT NULL,
    "priorityId" INTEGER NOT NULL,
    "typeId" INTEGER,
    "userId" INTEGER,
    "requesterName" TEXT NOT NULL DEFAULT '',
    "requesterEmail" TEXT NOT NULL DEFAULT '',
    "ownerStaffId" INTEGER,
    "slaPlanId" INTEGER,
    "dueAt" TIMESTAMP(3),
    "resolutionDueAt" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "reopenedAt" TIMESTAMP(3),
    "creationMode" "CreationMode" NOT NULL DEFAULT 'WEB',
    "creator" "ActorType" NOT NULL DEFAULT 'USER',
    "flagType" "FlagType" NOT NULL DEFAULT 'NONE',
    "totalReplies" INTEGER NOT NULL DEFAULT 0,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "hasNotes" BOOLEAN NOT NULL DEFAULT false,
    "isResolved" BOOLEAN NOT NULL DEFAULT false,
    "isEscalated" BOOLEAN NOT NULL DEFAULT false,
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "wasReopened" BOOLEAN NOT NULL DEFAULT false,
    "isPhoneCall" BOOLEAN NOT NULL DEFAULT false,
    "ipAddress" TEXT NOT NULL DEFAULT '0.0.0.0',
    "messageId" TEXT DEFAULT '',
    "mergedIntoId" INTEGER,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "lastReplyAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketPost" (
    "id" SERIAL NOT NULL,
    "ticketId" INTEGER NOT NULL,
    "authorType" "ActorType" NOT NULL DEFAULT 'USER',
    "staffId" INTEGER,
    "userId" INTEGER,
    "fullName" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL DEFAULT '',
    "contents" TEXT NOT NULL,
    "isHtml" BOOLEAN NOT NULL DEFAULT true,
    "isEmailed" BOOLEAN NOT NULL DEFAULT false,
    "isThirdParty" BOOLEAN NOT NULL DEFAULT false,
    "creationMode" "CreationMode" NOT NULL DEFAULT 'WEB',
    "messageId" TEXT DEFAULT '',
    "ipAddress" TEXT NOT NULL DEFAULT '0.0.0.0',
    "editedAt" TIMESTAMP(3),
    "editedByStaffId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketNote" (
    "id" SERIAL NOT NULL,
    "ticketId" INTEGER NOT NULL,
    "staffId" INTEGER,
    "contents" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" SERIAL NOT NULL,
    "ticketId" INTEGER,
    "postId" INTEGER,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "size" INTEGER NOT NULL DEFAULT 0,
    "sha1" TEXT NOT NULL DEFAULT '',
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketWatcher" (
    "ticketId" INTEGER NOT NULL,
    "staffId" INTEGER NOT NULL,

    CONSTRAINT "TicketWatcher_pkey" PRIMARY KEY ("ticketId","staffId")
);

-- CreateTable
CREATE TABLE "TicketTag" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "TicketTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketAuditLog" (
    "id" SERIAL NOT NULL,
    "ticketId" INTEGER NOT NULL,
    "staffId" INTEGER,
    "actorType" "ActorType" NOT NULL DEFAULT 'STAFF',
    "action" TEXT NOT NULL,
    "field" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketLink" (
    "id" SERIAL NOT NULL,
    "sourceId" INTEGER NOT NULL,
    "targetId" INTEGER NOT NULL,
    "linkType" TEXT NOT NULL DEFAULT 'related',

    CONSTRAINT "TicketLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlaSchedule" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "workHours" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlaSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlaHoliday" (
    "id" SERIAL NOT NULL,
    "scheduleId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlaHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlaPlan" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "criteria" JSONB NOT NULL DEFAULT '[]',
    "firstResponseSeconds" INTEGER,
    "resolutionSeconds" INTEGER,
    "scheduleId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlaPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscalationRule" (
    "id" SERIAL NOT NULL,
    "slaPlanId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "targetType" "SlaTargetType" NOT NULL DEFAULT 'FIRST_RESPONSE',
    "thresholdSeconds" INTEGER NOT NULL DEFAULT 0,
    "actions" JSONB NOT NULL DEFAULT '[]',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "EscalationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MacroCategory" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "parentId" INTEGER,

    CONSTRAINT "MacroCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Macro" (
    "id" SERIAL NOT NULL,
    "categoryId" INTEGER,
    "title" TEXT NOT NULL,
    "replyText" TEXT NOT NULL DEFAULT '',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Macro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "criteria" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailQueue" (
    "id" SERIAL NOT NULL,
    "type" "EmailQueueType" NOT NULL DEFAULT 'IMAP',
    "emailAddress" TEXT NOT NULL,
    "host" TEXT NOT NULL DEFAULT '',
    "port" INTEGER NOT NULL DEFAULT 993,
    "username" TEXT NOT NULL DEFAULT '',
    "passwordEnc" TEXT NOT NULL DEFAULT '',
    "useTls" BOOLEAN NOT NULL DEFAULT true,
    "departmentId" INTEGER,
    "signature" TEXT NOT NULL DEFAULT '',
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "subject" TEXT NOT NULL,
    "htmlBody" TEXT NOT NULL,
    "textBody" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldGroup" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "scope" "CustomFieldScope" NOT NULL DEFAULT 'TICKET',
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CustomFieldGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomField" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "CustomFieldType" NOT NULL DEFAULT 'TEXT',
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB NOT NULL DEFAULT '[]',
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CustomField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbCategory" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "parentId" INTEGER,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "KbCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbArticle" (
    "id" SERIAL NOT NULL,
    "categoryId" INTEGER,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "contents" TEXT NOT NULL,
    "contentsText" TEXT NOT NULL DEFAULT '',
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "views" INTEGER NOT NULL DEFAULT 0,
    "authorStaffId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KbArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbArticleRevision" (
    "id" SERIAL NOT NULL,
    "articleId" INTEGER NOT NULL,
    "contents" TEXT NOT NULL,
    "editedByStaffId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KbArticleRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsItem" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "contents" TEXT NOT NULL,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "authorStaffId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" SERIAL NOT NULL,
    "section" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL DEFAULT 'null',

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlarisEvent" (
    "id" SERIAL NOT NULL,
    "externalId" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "ticketId" INTEGER,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlarisEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_TicketToTicketTag" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_TicketToTicketTag_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Staff_email_key" ON "Staff"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Staff_username_key" ON "Staff"("username");

-- CreateIndex
CREATE INDEX "Staff_staffGroupId_idx" ON "Staff"("staffGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_staffId_idx" ON "RefreshToken"("staffId");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "UserEmail_email_key" ON "UserEmail"("email");

-- CreateIndex
CREATE INDEX "UserEmail_userId_idx" ON "UserEmail"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_mask_key" ON "Ticket"("mask");

-- CreateIndex
CREATE INDEX "Ticket_statusId_idx" ON "Ticket"("statusId");

-- CreateIndex
CREATE INDEX "Ticket_departmentId_idx" ON "Ticket"("departmentId");

-- CreateIndex
CREATE INDEX "Ticket_ownerStaffId_idx" ON "Ticket"("ownerStaffId");

-- CreateIndex
CREATE INDEX "Ticket_userId_idx" ON "Ticket"("userId");

-- CreateIndex
CREATE INDEX "Ticket_lastActivityAt_idx" ON "Ticket"("lastActivityAt");

-- CreateIndex
CREATE INDEX "Ticket_createdAt_idx" ON "Ticket"("createdAt");

-- CreateIndex
CREATE INDEX "TicketPost_ticketId_idx" ON "TicketPost"("ticketId");

-- CreateIndex
CREATE INDEX "TicketPost_messageId_idx" ON "TicketPost"("messageId");

-- CreateIndex
CREATE INDEX "TicketNote_ticketId_idx" ON "TicketNote"("ticketId");

-- CreateIndex
CREATE INDEX "Attachment_ticketId_idx" ON "Attachment"("ticketId");

-- CreateIndex
CREATE INDEX "Attachment_postId_idx" ON "Attachment"("postId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketTag_name_key" ON "TicketTag"("name");

-- CreateIndex
CREATE INDEX "TicketAuditLog_ticketId_idx" ON "TicketAuditLog"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketLink_sourceId_targetId_key" ON "TicketLink"("sourceId", "targetId");

-- CreateIndex
CREATE INDEX "SlaHoliday_scheduleId_idx" ON "SlaHoliday"("scheduleId");

-- CreateIndex
CREATE INDEX "EscalationRule_slaPlanId_idx" ON "EscalationRule"("slaPlanId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTemplate_key_locale_key" ON "EmailTemplate"("key", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "CustomField_groupId_fieldKey_key" ON "CustomField"("groupId", "fieldKey");

-- CreateIndex
CREATE UNIQUE INDEX "KbArticle_slug_key" ON "KbArticle"("slug");

-- CreateIndex
CREATE INDEX "KbArticle_categoryId_idx" ON "KbArticle"("categoryId");

-- CreateIndex
CREATE INDEX "KbArticleRevision_articleId_idx" ON "KbArticleRevision"("articleId");

-- CreateIndex
CREATE UNIQUE INDEX "Setting_section_key_key" ON "Setting"("section", "key");

-- CreateIndex
CREATE UNIQUE INDEX "AlarisEvent_externalId_key" ON "AlarisEvent"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "AlarisEvent_ticketId_key" ON "AlarisEvent"("ticketId");

-- CreateIndex
CREATE INDEX "_TicketToTicketTag_B_index" ON "_TicketToTicketTag"("B");

-- AddForeignKey
ALTER TABLE "Staff" ADD CONSTRAINT "Staff_staffGroupId_fkey" FOREIGN KEY ("staffGroupId") REFERENCES "StaffGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_slaPlanId_fkey" FOREIGN KEY ("slaPlanId") REFERENCES "SlaPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_userGroupId_fkey" FOREIGN KEY ("userGroupId") REFERENCES "UserGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEmail" ADD CONSTRAINT "UserEmail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentStaff" ADD CONSTRAINT "DepartmentStaff_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentStaff" ADD CONSTRAINT "DepartmentStaff_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "TicketStatus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_priorityId_fkey" FOREIGN KEY ("priorityId") REFERENCES "TicketPriority"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "TicketType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_ownerStaffId_fkey" FOREIGN KEY ("ownerStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_slaPlanId_fkey" FOREIGN KEY ("slaPlanId") REFERENCES "SlaPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketPost" ADD CONSTRAINT "TicketPost_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketPost" ADD CONSTRAINT "TicketPost_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketPost" ADD CONSTRAINT "TicketPost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketNote" ADD CONSTRAINT "TicketNote_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketNote" ADD CONSTRAINT "TicketNote_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "TicketPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketWatcher" ADD CONSTRAINT "TicketWatcher_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketWatcher" ADD CONSTRAINT "TicketWatcher_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAuditLog" ADD CONSTRAINT "TicketAuditLog_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAuditLog" ADD CONSTRAINT "TicketAuditLog_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLink" ADD CONSTRAINT "TicketLink_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLink" ADD CONSTRAINT "TicketLink_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlaHoliday" ADD CONSTRAINT "SlaHoliday_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "SlaSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlaPlan" ADD CONSTRAINT "SlaPlan_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "SlaSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscalationRule" ADD CONSTRAINT "EscalationRule_slaPlanId_fkey" FOREIGN KEY ("slaPlanId") REFERENCES "SlaPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MacroCategory" ADD CONSTRAINT "MacroCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "MacroCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Macro" ADD CONSTRAINT "Macro_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MacroCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailQueue" ADD CONSTRAINT "EmailQueue_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomField" ADD CONSTRAINT "CustomField_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CustomFieldGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbCategory" ADD CONSTRAINT "KbCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "KbCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbArticle" ADD CONSTRAINT "KbArticle_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "KbCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KbArticleRevision" ADD CONSTRAINT "KbArticleRevision_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KbArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlarisEvent" ADD CONSTRAINT "AlarisEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TicketToTicketTag" ADD CONSTRAINT "_TicketToTicketTag_A_fkey" FOREIGN KEY ("A") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TicketToTicketTag" ADD CONSTRAINT "_TicketToTicketTag_B_fkey" FOREIGN KEY ("B") REFERENCES "TicketTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
