-- CreateTable
CREATE TABLE "UserLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "externalSystem" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "externalUsername" TEXT,
    "metadata" JSONB,
    "active" BOOLEAN NOT NULL,
    "userEmail" TEXT,
    "userUsername" TEXT,
    "userFirstName" TEXT,
    "userLastName" TEXT,
    "erpAccessToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserLink_pkey" PRIMARY KEY ("id")
);
