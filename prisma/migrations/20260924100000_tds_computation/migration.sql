-- TDS Computation module: versioned, approved employee-wise TDS that payroll deducts from.

-- CreateEnum
CREATE TYPE "TdsComputationStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "TdsComputation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "financialYear" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "TdsComputationStatus" NOT NULL DEFAULT 'DRAFT',
    "taxRegime" "TaxRegime" NOT NULL,
    "revisionReason" TEXT,
    "grossIncome" DECIMAL(14,2) NOT NULL,
    "deductionLines" JSONB NOT NULL,
    "totalDeductions" DECIMAL(14,2) NOT NULL,
    "taxableIncome" DECIMAL(14,2) NOT NULL,
    "taxLiability" DECIMAL(14,2) NOT NULL,
    "cess" DECIMAL(14,2) NOT NULL,
    "annualTdsLiability" DECIMAL(14,2) NOT NULL,
    "tdsAlreadyDeducted" DECIMAL(14,2) NOT NULL,
    "balanceTds" DECIMAL(14,2) NOT NULL,
    "remainingMonths" INTEGER NOT NULL,
    "monthlyTds" DECIMAL(14,2) NOT NULL,
    "requestedByUserId" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TdsComputation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TdsComputation_companyId_employeeId_financialYear_idx" ON "TdsComputation"("companyId", "employeeId", "financialYear");

-- CreateIndex
CREATE INDEX "TdsComputation_companyId_employeeId_financialYear_status_idx" ON "TdsComputation"("companyId", "employeeId", "financialYear", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TdsComputation_companyId_id_key" ON "TdsComputation"("companyId", "id");

-- AddForeignKey
ALTER TABLE "TdsComputation" ADD CONSTRAINT "TdsComputation_companyId_employeeId_fkey" FOREIGN KEY ("companyId", "employeeId") REFERENCES "Employee"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================================================
-- Row-Level Security for the new tenant table (same policy as the rest).
-- =====================================================================================================
DO $$
BEGIN
  EXECUTE 'ALTER TABLE "TdsComputation" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY tenant_isolation ON "TdsComputation"
             USING (app_is_platform() OR "companyId" = app_tenant())
             WITH CHECK (app_is_platform() OR "companyId" = app_tenant())';
END
$$;

-- =====================================================================================================
-- DATA: give every existing company the new permission and role grant (new companies get it from
-- src/server/rbac/roles.ts at provisioning time).
-- =====================================================================================================

INSERT INTO "Permission" ("key", "module", "description") VALUES
  ('tds.manage', 'Payroll', 'Compute, revise and approve employee TDS')
ON CONFLICT ("key") DO NOTHING;

-- Company Admin (already gets every key) + Payroll Manager can compute and approve TDS.
INSERT INTO "RolePermission" ("roleId", "companyId", "permissionKey", "scope")
SELECT r."id", r."companyId", 'tds.manage', 'COMPANY'
FROM "Role" r WHERE r."key" IN ('COMPANY_ADMIN', 'PAYROLL_MANAGER')
ON CONFLICT DO NOTHING;
