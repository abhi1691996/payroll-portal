-- Employee offboarding: suspension, resignation (with approval + notice period) and termination.

-- CreateEnum
CREATE TYPE "SeparationType" AS ENUM ('RESIGNATION', 'TERMINATION');

-- CreateEnum
CREATE TYPE "SeparationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- AlterEnum
ALTER TYPE "EmploymentStatus" ADD VALUE 'SUSPENDED';
ALTER TYPE "EmploymentStatus" ADD VALUE 'RESIGNED';

-- CreateTable
CREATE TABLE "EmployeeSuspension" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE,
    "reason" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeSuspension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeSeparation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "SeparationType" NOT NULL,
    "status" "SeparationStatus" NOT NULL DEFAULT 'PENDING',
    "submittedDate" DATE NOT NULL,
    "noticePeriodDays" INTEGER,
    "lastWorkingDay" DATE NOT NULL,
    "reason" TEXT,
    "requestedByUserId" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeSeparation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeSuspension_companyId_employeeId_idx" ON "EmployeeSuspension"("companyId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeSuspension_companyId_id_key" ON "EmployeeSuspension"("companyId", "id");

-- CreateIndex
CREATE INDEX "EmployeeSeparation_companyId_employeeId_idx" ON "EmployeeSeparation"("companyId", "employeeId");

-- CreateIndex
CREATE INDEX "EmployeeSeparation_companyId_status_idx" ON "EmployeeSeparation"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeSeparation_companyId_id_key" ON "EmployeeSeparation"("companyId", "id");

-- AddForeignKey
ALTER TABLE "EmployeeSuspension" ADD CONSTRAINT "EmployeeSuspension_companyId_employeeId_fkey" FOREIGN KEY ("companyId", "employeeId") REFERENCES "Employee"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSeparation" ADD CONSTRAINT "EmployeeSeparation_companyId_employeeId_fkey" FOREIGN KEY ("companyId", "employeeId") REFERENCES "Employee"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================================================
-- Row-Level Security for the two new tenant tables (same policy as the rest).
-- =====================================================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['EmployeeSuspension', 'EmployeeSeparation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (app_is_platform() OR "companyId" = app_tenant())
         WITH CHECK (app_is_platform() OR "companyId" = app_tenant())', t);
  END LOOP;
END
$$;

-- =====================================================================================================
-- DATA: give every existing company the new permissions, role grants and the resignation approval
-- workflow (new companies get all of this from src/server/companies/defaults.ts and provisioning).
-- =====================================================================================================

INSERT INTO "Permission" ("key", "module", "description") VALUES
  ('employee.offboard', 'Employees', 'Suspend, reinstate, terminate and decide resignations'),
  ('resignation.request', 'Employees', 'Apply for their own resignation')
ON CONFLICT ("key") DO NOTHING;

-- HR (and Company Admin, which already gets every key) can suspend / terminate / decide resignations.
INSERT INTO "RolePermission" ("roleId", "companyId", "permissionKey", "scope")
SELECT r."id", r."companyId", 'employee.offboard', 'COMPANY'
FROM "Role" r WHERE r."key" IN ('COMPANY_ADMIN', 'HR_MANAGER')
ON CONFLICT DO NOTHING;

-- Every employee can apply for their own resignation.
INSERT INTO "RolePermission" ("roleId", "companyId", "permissionKey", "scope")
SELECT r."id", r."companyId", 'resignation.request', CASE WHEN r."key" = 'COMPANY_ADMIN' THEN 'COMPANY' ELSE 'OWN' END::"PermissionScope"
FROM "Role" r WHERE r."key" IN ('COMPANY_ADMIN', 'EMPLOYEE')
ON CONFLICT DO NOTHING;

-- Resignation approval: the employee's reporting manager (HR / admins can always decide), same shape as leave.
INSERT INTO "ApprovalWorkflow" ("id", "companyId", "entityType", "name")
SELECT md5(c."id" || 'wf-resign'), c."id", 'RESIGNATION', 'Resignation approval'
FROM "Company" c
WHERE NOT EXISTS (SELECT 1 FROM "ApprovalWorkflow" w WHERE w."companyId" = c."id" AND w."entityType" = 'RESIGNATION');

INSERT INTO "ApprovalLevel" ("id", "companyId", "workflowId", "levelNo", "approverType")
SELECT md5(c."id" || 'wfl1-resign'), c."id", md5(c."id" || 'wf-resign'), 1, 'REPORTING_MANAGER'
FROM "Company" c
WHERE NOT EXISTS (
  SELECT 1 FROM "ApprovalLevel" l JOIN "ApprovalWorkflow" w ON w."id" = l."workflowId" AND w."companyId" = l."companyId"
  WHERE l."companyId" = c."id" AND w."entityType" = 'RESIGNATION'
);
