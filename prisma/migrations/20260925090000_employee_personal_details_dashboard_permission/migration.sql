-- New employee personal-detail fields, plus the dashboard.read permission for the management dashboard.

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "MaritalStatus" AS ENUM ('SINGLE', 'MARRIED', 'OTHER');

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "bloodGroup" TEXT,
ADD COLUMN     "dateOfBirth" DATE,
ADD COLUMN     "emergencyContactName" TEXT,
ADD COLUMN     "emergencyContactPhone" TEXT,
ADD COLUMN     "gender" "Gender",
ADD COLUMN     "maritalStatus" "MaritalStatus";

-- =====================================================================================================
-- DATA: give every existing company the new permission and role grant (new companies get it from
-- src/server/rbac/roles.ts at provisioning time). Company Admin only, by design.
-- =====================================================================================================

INSERT INTO "Permission" ("key", "module", "description") VALUES
  ('dashboard.read', 'Reports', 'View the daily management dashboard')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "companyId", "permissionKey", "scope")
SELECT r."id", r."companyId", 'dashboard.read', 'COMPANY'
FROM "Role" r WHERE r."key" = 'COMPANY_ADMIN'
ON CONFLICT DO NOTHING;
