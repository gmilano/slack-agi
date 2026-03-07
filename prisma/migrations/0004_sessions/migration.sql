-- AlterTable
ALTER TABLE "Channel" ADD COLUMN "isEphemeral" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Channel" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "Channel" ADD COLUMN "ephemeralTag" TEXT;

-- CreateTable
CREATE TABLE "SessionThread" (
    "id" TEXT NOT NULL,
    "channelId" TEXT,
    "missionId" TEXT,
    "topicId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "ttlMinutes" INTEGER NOT NULL DEFAULT 120,
    "autoCloseAt" TIMESTAMP(3) NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "artifactId" TEXT,
    "memberIds" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionThread_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "SessionThread" ADD CONSTRAINT "SessionThread_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionThread" ADD CONSTRAINT "SessionThread_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionThread" ADD CONSTRAINT "SessionThread_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
