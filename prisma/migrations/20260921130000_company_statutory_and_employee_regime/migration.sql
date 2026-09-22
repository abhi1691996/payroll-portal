-- 1. Statutory rates become per-company -----------------------------------------------------------
-- Existing (formerly global) rows are copied into EVERY company, then the global rows are removed.
ALTER TABLE "StatutoryConfig" ADD COLUMN "companyId" TEXT;

INSERT INTO "StatutoryConfig" (
  "id", "companyId", "effectiveFrom", "pfEmployeeRate", "pfEmployerRate", "pfWageCeiling",
  "esiEmployeeRate", "esiEmployerRate", "esiWageThreshold", "professionalTaxSlabs", "incomeTaxSlabs", "createdAt"
)
SELECT
  md5(random()::text || clock_timestamp()::text || s."id" || c."id"), c."id", s."effectiveFrom",
  s."pfEmployeeRate", s."pfEmployerRate", s."pfWageCeiling", s."esiEmployeeRate", s."esiEmployerRate",
  s."esiWageThreshold", s."professionalTaxSlabs", s."incomeTaxSlabs", s."createdAt"
FROM "StatutoryConfig" s
CROSS JOIN "Company" c
WHERE s."companyId" IS NULL;

DELETE FROM "StatutoryConfig" WHERE "companyId" IS NULL;

ALTER TABLE "StatutoryConfig" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "StatutoryConfig"
  ADD CONSTRAINT "StatutoryConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "StatutoryConfig_companyId_effectiveFrom_idx" ON "StatutoryConfig"("companyId", "effectiveFrom");

-- Row-Level Security: same tenant policy as every other tenant table (replaces the platform policies).
DROP POLICY IF EXISTS platform_read ON "StatutoryConfig";
DROP POLICY IF EXISTS platform_write ON "StatutoryConfig";
CREATE POLICY tenant_isolation ON "StatutoryConfig"
  USING (app_is_platform() OR "companyId" = app_tenant())
  WITH CHECK (app_is_platform() OR "companyId" = app_tenant());

-- 2. Tax regime moves from the salary structure to the employee -------------------------------------
ALTER TABLE "Employee" ADD COLUMN "taxRegime" "TaxRegime" NOT NULL DEFAULT 'NEW';

-- Carry over each employee's most recent choice.
UPDATE "Employee" e
SET "taxRegime" = latest."taxRegime"
FROM (
  SELECT DISTINCT ON ("employeeId") "employeeId", "taxRegime"
  FROM "SalaryStructure"
  ORDER BY "employeeId", "effectiveFrom" DESC
) latest
WHERE latest."employeeId" = e."id";

ALTER TABLE "SalaryStructure" DROP COLUMN "taxRegime";
