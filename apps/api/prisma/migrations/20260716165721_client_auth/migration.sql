-- CreateTable
CREATE TABLE "ClientLoginToken" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientLoginToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientSession" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientLoginToken_tokenHash_key" ON "ClientLoginToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ClientLoginToken_userId_idx" ON "ClientLoginToken"("userId");

-- CreateIndex
CREATE INDEX "ClientLoginToken_expiresAt_idx" ON "ClientLoginToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClientSession_tokenHash_key" ON "ClientSession"("tokenHash");

-- CreateIndex
CREATE INDEX "ClientSession_userId_idx" ON "ClientSession"("userId");

-- CreateIndex
CREATE INDEX "ClientSession_expiresAt_idx" ON "ClientSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "ClientLoginToken" ADD CONSTRAINT "ClientLoginToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientSession" ADD CONSTRAINT "ClientSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
