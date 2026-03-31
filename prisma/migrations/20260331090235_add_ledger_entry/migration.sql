-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "tkDuong" TEXT NOT NULL,
    "no" DOUBLE PRECISION NOT NULL,
    "co" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_month_year_tkDuong_key" ON "LedgerEntry"("month", "year", "tkDuong");
