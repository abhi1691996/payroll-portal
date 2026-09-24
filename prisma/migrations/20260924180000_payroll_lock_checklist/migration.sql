-- Pre-payroll checklist: explicit attendance/loans/other-deductions locks, plus a new ad-hoc deduction
-- type. No new Permission rows — both are gated by the existing payroll.run / payroll.finalize keys.

-- CreateEnum
CREATE TYPE "PayrollLockKind" AS ENUM ('ATTENDANCE', 'LOANS', 'OTHER_DEDUCTIONS');

-- CreateTable
CREATE TABLE "PayrollPeriodLock" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "kind" "PayrollLockKind" NOT NULL,
    "payload" JSONB,
    "lockedByUserId" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlockedByUserId" TEXT,
    "unlockedAt" TIMESTAMP(3),

    CONSTRAINT "PayrollPeriodLock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdHocDeduction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdHocDeduction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollPeriodLock_companyId_month_year_idx" ON "PayrollPeriodLock"("companyId", "month", "year");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPeriodLock_companyId_month_year_kind_key" ON "PayrollPeriodLock"("companyId", "month", "year", "kind");

-- CreateIndex
CREATE INDEX "AdHocDeduction_companyId_employeeId_idx" ON "AdHocDeduction"("companyId", "employeeId");

-- CreateIndex
CREATE INDEX "AdHocDeduction_companyId_month_year_idx" ON "AdHocDeduction"("companyId", "month", "year");

-- CreateIndex
CREATE UNIQUE INDEX "AdHocDeduction_companyId_id_key" ON "AdHocDeduction"("companyId", "id");

-- AddForeignKey
ALTER TABLE "AdHocDeduction" ADD CONSTRAINT "AdHocDeduction_companyId_employeeId_fkey" FOREIGN KEY ("companyId", "employeeId") REFERENCES "Employee"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================================================
-- Row-Level Security for the two new tenant tables (same policy as the rest).
-- =====================================================================================================
DO $$
BEGIN
  EXECUTE 'ALTER TABLE "PayrollPeriodLock" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY tenant_isolation ON "PayrollPeriodLock"
             USING (app_is_platform() OR "companyId" = app_tenant())
             WITH CHECK (app_is_platform() OR "companyId" = app_tenant())';
END
$$;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE "AdHocDeduction" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY tenant_isolation ON "AdHocDeduction"
             USING (app_is_platform() OR "companyId" = app_tenant())
             WITH CHECK (app_is_platform() OR "companyId" = app_tenant())';
END
$$;
