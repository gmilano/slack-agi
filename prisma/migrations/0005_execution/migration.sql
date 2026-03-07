-- CreateTable
CREATE TABLE "ActionPlan" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "missionId" TEXT,
    "channelId" TEXT,
    "title" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionItem" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assigneeId" TEXT NOT NULL,
    "canAutoExecute" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "outputArtifactId" TEXT,
    "executedAt" TIMESTAMP(3),
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ActionItem_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ActionPlan" ADD CONSTRAINT "ActionPlan_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SessionThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionPlan" ADD CONSTRAINT "ActionPlan_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionPlan" ADD CONSTRAINT "ActionPlan_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ActionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_outputArtifactId_fkey" FOREIGN KEY ("outputArtifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
