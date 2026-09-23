-- Employee category, optional last name, WFH attendance status, and loans & advances.

-- CreateEnum
CREATE TYPE "EmployeeCategory" AS ENUM ('WHITE_COLLAR', 'BLUE_COLLAR', 'OTHER');

-- CreateEnum
CREATE TYPE "LoanType" AS ENUM ('LOAN', 'ADVANCE');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CLOSED', 'WITHDRAWN');

-- AlterEnum
ALTER TYPE "AttendanceStatus" ADD VALUE 'WFH';

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "category" "EmployeeCategory" NOT NULL DEFAULT 'WHITE_COLLAR',
ALTER COLUMN "lastName" SET DEFAULT '';

-- CreateTable
CREATE TABLE "EmployeeLoan" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "LoanType" NOT NULL,
    "status" "LoanStatus" NOT NULL DEFAULT 'PENDING',
    "principalAmount" DECIMAL(14,2) NOT NULL,
    "tenureMonths" INTEGER NOT NULL,
    "monthlyInstallment" DECIMAL(14,2) NOT NULL,
    "outstandingBalance" DECIMAL(14,2) NOT NULL,
    "reason" TEXT,
    "appliedDate" DATE NOT NULL,
    "requestedByUserId" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeLoan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanInstallment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeLoan_companyId_employeeId_idx" ON "EmployeeLoan"("companyId", "employeeId");

-- CreateIndex
CREATE INDEX "EmployeeLoan_companyId_status_idx" ON "EmployeeLoan"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeLoan_companyId_id_key" ON "EmployeeLoan"("companyId", "id");

-- CreateIndex
CREATE INDEX "LoanInstallment_companyId_payrollRunId_idx" ON "LoanInstallment"("companyId", "payrollRunId");

-- CreateIndex
CREATE UNIQUE INDEX "LoanInstallment_companyId_id_key" ON "LoanInstallment"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LoanInstallment_loanId_month_year_key" ON "LoanInstallment"("loanId", "month", "year");

-- AddForeignKey
ALTER TABLE "EmployeeLoan" ADD CONSTRAINT "EmployeeLoan_companyId_employeeId_fkey" FOREIGN KEY ("companyId", "employeeId") REFERENCES "Employee"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanInstallment" ADD CONSTRAINT "LoanInstallment_companyId_loanId_fkey" FOREIGN KEY ("companyId", "loanId") REFERENCES "EmployeeLoan"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanInstallment" ADD CONSTRAINT "LoanInstallment_companyId_payrollRunId_fkey" FOREIGN KEY ("companyId", "payrollRunId") REFERENCES "PayrollRun"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================================================
-- Row-Level Security for the two new tenant tables (same policy as the rest).
-- =====================================================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['EmployeeLoan', 'LoanInstallment'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (app_is_platform() OR "companyId" = app_tenant())
         WITH CHECK (app_is_platform() OR "companyId" = app_tenant())', t);
  END LOOP;
END
$$;

-- =====================================================================================================
-- DATA: give every existing company the new permissions and role grants (new companies get them from
-- src/server/rbac/roles.ts at provisioning time).
-- =====================================================================================================

INSERT INTO "Permission" ("key", "module", "description") VALUES
  ('loan.request', 'Employees', 'Apply for a loan or salary advance'),
  ('loan.manage', 'Employees', 'Approve, reject and process loan/advance deductions')
ON CONFLICT ("key") DO NOTHING;

-- Company Admin (already gets every key) + Payroll Manager can approve/reject and process deductions.
INSERT INTO "RolePermission" ("roleId", "companyId", "permissionKey", "scope")
SELECT r."id", r."companyId", 'loan.manage', 'COMPANY'
FROM "Role" r WHERE r."key" IN ('COMPANY_ADMIN', 'PAYROLL_MANAGER')
ON CONFLICT DO NOTHING;

-- Every employee can apply for their own loan/advance.
INSERT INTO "RolePermission" ("roleId", "companyId", "permissionKey", "scope")
SELECT r."id", r."companyId", 'loan.request', CASE WHEN r."key" = 'COMPANY_ADMIN' THEN 'COMPANY' ELSE 'OWN' END::"PermissionScope"
FROM "Role" r WHERE r."key" IN ('COMPANY_ADMIN', 'EMPLOYEE')
ON CONFLICT DO NOTHING;
