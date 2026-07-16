-- RBAC audit trail: who changed which staff member / group, when.
-- CreateTable
CREATE TABLE "RbacAuditLog" (
    "id" SERIAL NOT NULL,
    "actorStaffId" INTEGER,
    "actorEmail" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" INTEGER,
    "targetLabel" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RbacAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RbacAuditLog_createdAt_idx" ON "RbacAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "RbacAuditLog_actorStaffId_idx" ON "RbacAuditLog"("actorStaffId");

-- CreateIndex
CREATE INDEX "RbacAuditLog_targetType_targetId_idx" ON "RbacAuditLog"("targetType", "targetId");
