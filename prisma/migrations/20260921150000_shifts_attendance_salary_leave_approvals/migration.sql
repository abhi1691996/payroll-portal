-- CreateEnum
CREATE TYPE "SalaryCalcType" AS ENUM ('FIXED', 'PERCENT_OF_BASIC', 'PERCENT_OF_CTC', 'BALANCE');

-- CreateEnum
CREATE TYPE "LateAction" AS ENUM ('MARK_LATE', 'HALF_DAY');

-- CreateEnum
CREATE TYPE "EarlyLeaveAction" AS ENUM ('MARK_EARLY', 'HALF_DAY');

-- CreateEnum
CREATE TYPE "MissingPunchAction" AS ENUM ('PRESENT', 'HALF_DAY', 'ABSENT');

-- CreateEnum
CREATE TYPE "LopBasis" AS ENUM ('CALENDAR_DAYS', 'WORKING_DAYS');

-- CreateEnum
CREATE TYPE "AccrualMode" AS ENUM ('UPFRONT', 'MONTHLY');

-- CreateEnum
CREATE TYPE "LedgerKind" AS ENUM ('OPENING', 'ACCRUAL', 'LEAVE_TAKEN', 'ADJUSTMENT', 'LAPSE', 'REVERSAL');

-- CreateEnum
CREATE TYPE "ApproverType" AS ENUM ('REPORTING_MANAGER', 'ROLE');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalActionType" AS ENUM ('APPROVE', 'REJECT', 'RETURN', 'COMMENT');

-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "earlyLeaveMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "flags" TEXT,
ADD COLUMN     "inAt" TIMESTAMP(3),
ADD COLUMN     "isLate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lateMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "outAt" TIMESTAMP(3),
ADD COLUMN     "overtimeMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "workedMinutes" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "leavePolicyId" TEXT,
ADD COLUMN     "shiftId" TEXT;

-- AlterTable
ALTER TABLE "LeaveRequest" ADD COLUMN     "days" DECIMAL(5,1) NOT NULL DEFAULT 0,
ADD COLUMN     "isHalfDay" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "LeaveType" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "code" TEXT,
ADD COLUMN     "isPaid" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "SalaryComponent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "calcType" "SalaryCalcType" NOT NULL DEFAULT 'FIXED',
    "defaultValue" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "isBasic" BOOLEAN NOT NULL DEFAULT false,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "includeInPf" BOOLEAN NOT NULL DEFAULT false,
    "includeInEsi" BOOLEAN NOT NULL DEFAULT true,
    "includeInPt" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalaryComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryTemplate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalaryTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryTemplateLine" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "calcType" "SalaryCalcType" NOT NULL,
    "value" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SalaryTemplateLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeSalary" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "templateId" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "ctcAnnual" DECIMAL(14,2) NOT NULL,
    "lines" JSONB NOT NULL,
    "grossMonthly" DECIMAL(14,2) NOT NULL,
    "employerPfOptIn" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeSalary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startMinutes" INTEGER NOT NULL,
    "endMinutes" INTEGER NOT NULL,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "lateGraceMinutes" INTEGER NOT NULL DEFAULT 0,
    "earlyLeaveGraceMinutes" INTEGER NOT NULL DEFAULT 0,
    "isFlexible" BOOLEAN NOT NULL DEFAULT false,
    "flexibleMinutes" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Holiday" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceRule" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "weeklyPattern" JSONB NOT NULL,
    "absentIfNoRecord" BOOLEAN NOT NULL DEFAULT false,
    "lateAction" "LateAction" NOT NULL DEFAULT 'MARK_LATE',
    "lateHalfDayAfterMinutes" INTEGER,
    "lateCountPerHalfDay" INTEGER NOT NULL DEFAULT 0,
    "earlyLeaveAction" "EarlyLeaveAction" NOT NULL DEFAULT 'MARK_EARLY',
    "halfDayBelowMinutes" INTEGER NOT NULL DEFAULT 240,
    "absentBelowMinutes" INTEGER NOT NULL DEFAULT 0,
    "missingPunchAction" "MissingPunchAction" NOT NULL DEFAULT 'PRESENT',
    "otEnabled" BOOLEAN NOT NULL DEFAULT false,
    "otPayable" BOOLEAN NOT NULL DEFAULT false,
    "otMinMinutes" INTEGER NOT NULL DEFAULT 30,
    "otMultiplier" DECIMAL(4,2) NOT NULL DEFAULT 1.5,
    "otOnOffDays" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanySetting" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leaveYearStartMonth" INTEGER NOT NULL DEFAULT 1,
    "employeeCodePrefix" TEXT NOT NULL DEFAULT 'EMP',
    "autoGenerateEmployeeCode" BOOLEAN NOT NULL DEFAULT false,
    "defaultTaxRegime" "TaxRegime" NOT NULL DEFAULT 'NEW',
    "defaultShiftId" TEXT,
    "defaultLeavePolicyId" TEXT,
    "lopBasis" "LopBasis" NOT NULL DEFAULT 'CALENDAR_DAYS',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanySetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeavePolicy" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeavePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeavePolicyRule" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "entitlementDays" DECIMAL(6,2) NOT NULL,
    "accrual" "AccrualMode" NOT NULL DEFAULT 'UPFRONT',
    "carryForward" BOOLEAN NOT NULL DEFAULT false,
    "maxCarryForwardDays" DECIMAL(6,2),
    "maxBalance" DECIMAL(6,2),
    "encashable" BOOLEAN NOT NULL DEFAULT false,
    "allowHalfDay" BOOLEAN NOT NULL DEFAULT true,
    "maxConsecutiveDays" INTEGER,
    "countWeeklyOffs" BOOLEAN NOT NULL DEFAULT false,
    "countHolidays" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "LeavePolicyRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveLedger" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "kind" "LedgerKind" NOT NULL,
    "days" DECIMAL(7,2) NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "period" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalWorkflow" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ApprovalWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalLevel" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "levelNo" INTEGER NOT NULL,
    "approverType" "ApproverType" NOT NULL,
    "roleKey" TEXT,

    CONSTRAINT "ApprovalLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "subjectEmployeeId" TEXT,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "currentLevel" INTEGER NOT NULL DEFAULT 1,
    "levelsSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalAction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "levelNo" INTEGER NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorName" TEXT,
    "action" "ApprovalActionType" NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalaryComponent_companyId_code_key" ON "SalaryComponent"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryComponent_companyId_id_key" ON "SalaryComponent"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryTemplate_companyId_name_key" ON "SalaryTemplate"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryTemplate_companyId_id_key" ON "SalaryTemplate"("companyId", "id");

-- CreateIndex
CREATE INDEX "SalaryTemplateLine_companyId_idx" ON "SalaryTemplateLine"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryTemplateLine_templateId_componentId_key" ON "SalaryTemplateLine"("templateId", "componentId");

-- CreateIndex
CREATE INDEX "EmployeeSalary_companyId_employeeId_effectiveFrom_idx" ON "EmployeeSalary"("companyId", "employeeId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_companyId_name_key" ON "Shift"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_companyId_id_key" ON "Shift"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Holiday_companyId_date_key" ON "Holiday"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceRule_companyId_key" ON "AttendanceRule"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanySetting_companyId_key" ON "CompanySetting"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "LeavePolicy_companyId_name_key" ON "LeavePolicy"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "LeavePolicy_companyId_id_key" ON "LeavePolicy"("companyId", "id");

-- CreateIndex
CREATE INDEX "LeavePolicyRule_companyId_idx" ON "LeavePolicyRule"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "LeavePolicyRule_policyId_leaveTypeId_key" ON "LeavePolicyRule"("policyId", "leaveTypeId");

-- CreateIndex
CREATE INDEX "LeaveLedger_companyId_employeeId_leaveTypeId_idx" ON "LeaveLedger"("companyId", "employeeId", "leaveTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveLedger_employeeId_leaveTypeId_kind_period_key" ON "LeaveLedger"("employeeId", "leaveTypeId", "kind", "period");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalWorkflow_companyId_entityType_key" ON "ApprovalWorkflow"("companyId", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalWorkflow_companyId_id_key" ON "ApprovalWorkflow"("companyId", "id");

-- CreateIndex
CREATE INDEX "ApprovalLevel_companyId_idx" ON "ApprovalLevel"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalLevel_workflowId_levelNo_key" ON "ApprovalLevel"("workflowId", "levelNo");

-- CreateIndex
CREATE INDEX "ApprovalRequest_companyId_status_idx" ON "ApprovalRequest"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRequest_entityType_entityId_key" ON "ApprovalRequest"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRequest_companyId_id_key" ON "ApprovalRequest"("companyId", "id");

-- CreateIndex
CREATE INDEX "ApprovalAction_companyId_requestId_idx" ON "ApprovalAction"("companyId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveType_companyId_code_key" ON "LeaveType"("companyId", "code");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_companyId_shiftId_fkey" FOREIGN KEY ("companyId", "shiftId") REFERENCES "Shift"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_companyId_leavePolicyId_fkey" FOREIGN KEY ("companyId", "leavePolicyId") REFERENCES "LeavePolicy"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryTemplateLine" ADD CONSTRAINT "SalaryTemplateLine_companyId_templateId_fkey" FOREIGN KEY ("companyId", "templateId") REFERENCES "SalaryTemplate"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryTemplateLine" ADD CONSTRAINT "SalaryTemplateLine_companyId_componentId_fkey" FOREIGN KEY ("companyId", "componentId") REFERENCES "SalaryComponent"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSalary" ADD CONSTRAINT "EmployeeSalary_companyId_employeeId_fkey" FOREIGN KEY ("companyId", "employeeId") REFERENCES "Employee"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSalary" ADD CONSTRAINT "EmployeeSalary_companyId_templateId_fkey" FOREIGN KEY ("companyId", "templateId") REFERENCES "SalaryTemplate"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePolicyRule" ADD CONSTRAINT "LeavePolicyRule_companyId_policyId_fkey" FOREIGN KEY ("companyId", "policyId") REFERENCES "LeavePolicy"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePolicyRule" ADD CONSTRAINT "LeavePolicyRule_companyId_leaveTypeId_fkey" FOREIGN KEY ("companyId", "leaveTypeId") REFERENCES "LeaveType"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveLedger" ADD CONSTRAINT "LeaveLedger_companyId_employeeId_fkey" FOREIGN KEY ("companyId", "employeeId") REFERENCES "Employee"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveLedger" ADD CONSTRAINT "LeaveLedger_companyId_leaveTypeId_fkey" FOREIGN KEY ("companyId", "leaveTypeId") REFERENCES "LeaveType"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalLevel" ADD CONSTRAINT "ApprovalLevel_companyId_workflowId_fkey" FOREIGN KEY ("companyId", "workflowId") REFERENCES "ApprovalWorkflow"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalAction" ADD CONSTRAINT "ApprovalAction_companyId_requestId_fkey" FOREIGN KEY ("companyId", "requestId") REFERENCES "ApprovalRequest"("companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================================================
-- DATA: give every existing company the new structures, converting what it already has.
-- (New companies get the same defaults from src/server/companies/defaults.ts.)
-- =====================================================================================================

-- LeaveType had no foreign key to Company, so rows can outlive a removed company. Drop such orphans first.
DELETE FROM "LeaveType" WHERE "companyId" NOT IN (SELECT "id" FROM "Company");

-- Salary components + a starter template (editable / replaceable in Settings -> Salary Rules) ---------
INSERT INTO "SalaryComponent" ("id","companyId","code","name","calcType","defaultValue","isBasic","taxable","includeInPf","includeInEsi","includeInPt","active","sortOrder")
SELECT md5(c."id" || 'comp' || d.code), c."id", d.code, d.name, d.calc::"SalaryCalcType", d.val, d.basic, true, d.pf, true, true, true, d.ord
FROM "Company" c
CROSS JOIN (VALUES
  ('BASIC',   'Basic',             'PERCENT_OF_CTC',   50, true,  true,  1),
  ('HRA',     'HRA',               'PERCENT_OF_BASIC', 40, false, false, 2),
  ('SPECIAL', 'Special Allowance', 'BALANCE',           0, false, false, 3),
  ('OTHER',   'Other Allowances',  'FIXED',             0, false, false, 4)
) AS d(code, name, calc, val, basic, pf, ord);

INSERT INTO "SalaryTemplate" ("id","companyId","name","description")
SELECT md5(c."id" || 'tpl'), c."id", 'Standard', 'Starter structure - edit it or create your own under Settings -> Salary Rules.'
FROM "Company" c;

INSERT INTO "SalaryTemplateLine" ("id","companyId","templateId","componentId","calcType","value","sortOrder")
SELECT md5(c."id" || 'line' || sc."code"), c."id", md5(c."id" || 'tpl'), sc."id", sc."calcType", sc."defaultValue", sc."sortOrder"
FROM "Company" c JOIN "SalaryComponent" sc ON sc."companyId" = c."id";

-- Existing salary rows become dated EmployeeSalary records with their component amounts snapshotted.
INSERT INTO "EmployeeSalary" ("id","companyId","employeeId","templateId","effectiveFrom","effectiveTo","ctcAnnual","lines","grossMonthly","employerPfOptIn","createdAt")
SELECT s."id", s."companyId", s."employeeId", NULL, s."effectiveFrom", s."effectiveTo", s."ctcAnnual",
  jsonb_build_array(
    jsonb_build_object('code','BASIC','name','Basic','monthlyAmount',s."basicMonthly",'isBasic',true,'taxable',true,'includeInPf',true,'includeInEsi',true,'includeInPt',true,'sortOrder',1),
    jsonb_build_object('code','HRA','name','HRA','monthlyAmount',s."hraMonthly",'isBasic',false,'taxable',true,'includeInPf',false,'includeInEsi',true,'includeInPt',true,'sortOrder',2),
    jsonb_build_object('code','SPECIAL','name','Special Allowance','monthlyAmount',s."specialAllowance",'isBasic',false,'taxable',true,'includeInPf',false,'includeInEsi',true,'includeInPt',true,'sortOrder',3),
    jsonb_build_object('code','OTHER','name','Other Allowances','monthlyAmount',s."otherAllowances",'isBasic',false,'taxable',true,'includeInPf',false,'includeInEsi',true,'includeInPt',true,'sortOrder',4)
  ),
  s."basicMonthly" + s."hraMonthly" + s."specialAllowance" + s."otherAllowances", s."employerPfOptIn", s."createdAt"
FROM "SalaryStructure" s;

-- Shift, working week and attendance rules ------------------------------------------------------------
INSERT INTO "Shift" ("id","companyId","name","startMinutes","endMinutes","breakMinutes","lateGraceMinutes","earlyLeaveGraceMinutes","isFlexible","active")
SELECT md5(c."id" || 'shift'), c."id", 'General', 570, 1110, 60, 15, 15, false, true FROM "Company" c;

INSERT INTO "AttendanceRule" ("id","companyId","weeklyPattern","updatedAt")
SELECT md5(c."id" || 'ar'), c."id",
  '{"mon":{"mode":"WORKING"},"tue":{"mode":"WORKING"},"wed":{"mode":"WORKING"},"thu":{"mode":"WORKING"},"fri":{"mode":"WORKING"},"sat":{"mode":"WORKING"},"sun":{"mode":"OFF"}}'::jsonb,
  now()
FROM "Company" c;

-- Leave: codes, Loss of Pay, a "Standard" policy built from the old quotas, opening balances ------------
UPDATE "LeaveType" SET "code" = upper(regexp_replace("name", '[^A-Za-z0-9]+', '_', 'g'));
INSERT INTO "LeaveType" ("id","companyId","name","code","isPaid","active","annualQuota","carryForwardAllowed")
SELECT md5(c."id" || 'lop'), c."id", 'Loss of Pay', 'LOP', false, true, 0, false
FROM "Company" c WHERE NOT EXISTS (SELECT 1 FROM "LeaveType" t WHERE t."companyId" = c."id" AND t."code" = 'LOP');
ALTER TABLE "LeaveType" ALTER COLUMN "code" SET NOT NULL;

INSERT INTO "LeavePolicy" ("id","companyId","name","description")
SELECT md5(c."id" || 'lp'), c."id", 'Standard', 'Default leave policy' FROM "Company" c;

INSERT INTO "LeavePolicyRule" ("id","companyId","policyId","leaveTypeId","entitlementDays","accrual","carryForward","encashable","allowHalfDay","countWeeklyOffs","countHolidays")
SELECT md5(t."id" || 'rule'), t."companyId", md5(t."companyId" || 'lp'), t."id", t."annualQuota", 'UPFRONT', t."carryForwardAllowed", false, true, false, false
FROM "LeaveType" t WHERE t."isPaid";

UPDATE "Employee" SET "leavePolicyId" = md5("companyId" || 'lp');

INSERT INTO "CompanySetting" ("id","companyId","defaultShiftId","defaultLeavePolicyId","updatedAt")
SELECT md5(c."id" || 'cs'), c."id", md5(c."id" || 'shift'), md5(c."id" || 'lp'), now() FROM "Company" c;

-- The old free-standing balances become opening ledger entries (the balance is now the SUM of the ledger).
INSERT INTO "LeaveLedger" ("id","companyId","employeeId","leaveTypeId","kind","days","effectiveDate","period","note")
SELECT md5(b."id" || 'open'), b."companyId", b."employeeId", b."leaveTypeId", 'OPENING', b."balance", CURRENT_DATE, 'OPENING', 'Migrated from the previous balance'
FROM "LeaveBalance" b;

UPDATE "LeaveRequest" SET "days" = ("endDate" - "startDate") + 1;

-- Approvals: one level, the employee's reporting manager (HR / admins can always decide) ---------------
INSERT INTO "ApprovalWorkflow" ("id","companyId","entityType","name")
SELECT md5(c."id" || 'wf'), c."id", 'LEAVE', 'Leave approval' FROM "Company" c;
INSERT INTO "ApprovalLevel" ("id","companyId","workflowId","levelNo","approverType")
SELECT md5(c."id" || 'wfl1'), c."id", md5(c."id" || 'wf'), 1, 'REPORTING_MANAGER' FROM "Company" c;

-- =====================================================================================================
-- Retire the structures that were replaced (their data was copied above).
-- =====================================================================================================
ALTER TABLE "LeaveBalance" DROP CONSTRAINT "LeaveBalance_companyId_employeeId_fkey";
ALTER TABLE "LeaveBalance" DROP CONSTRAINT "LeaveBalance_companyId_leaveTypeId_fkey";
ALTER TABLE "SalaryStructure" DROP CONSTRAINT "SalaryStructure_companyId_employeeId_fkey";
DROP TABLE "LeaveBalance";
DROP TABLE "SalaryStructure";
ALTER TABLE "LeaveType" DROP COLUMN "annualQuota", DROP COLUMN "carryForwardAllowed";

-- =====================================================================================================
-- Row-Level Security for every new tenant table (same policy as the rest).
-- =====================================================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'SalaryComponent','SalaryTemplate','SalaryTemplateLine','EmployeeSalary','Shift','Holiday',
    'AttendanceRule','CompanySetting','LeavePolicy','LeavePolicyRule','LeaveLedger',
    'ApprovalWorkflow','ApprovalLevel','ApprovalRequest','ApprovalAction'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (app_is_platform() OR "companyId" = app_tenant())
         WITH CHECK (app_is_platform() OR "companyId" = app_tenant())', t);
  END LOOP;
END
$$;
