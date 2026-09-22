-- Tenant isolation at the database layer.
--
-- The application connects as `payroll_app`, a NON-owner, NON-superuser role, so the policies below
-- always apply to it. Each request runs inside a transaction that first executes
--     SELECT set_config('app.tenant_id', '<companyId>', true)      -- tenant work
--  or SELECT set_config('app.platform', 'on', true)                 -- trusted platform work (login, Super Admin)
-- (see src/server/tenancy/db.ts). With neither set, a tenant table returns no rows.
--
-- This is the BACKSTOP. The primary guard is the tenant-scoped Prisma client, and composite foreign
-- keys in the schema stop a row in one company pointing at another company's record.

-- 1. Application role ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'payroll_app') THEN
    -- Placeholder password so hosts like Neon (which reject weak passwords outright, even
    -- transiently) accept role creation. Rotate immediately after first run in any environment:
    --   ALTER ROLE payroll_app PASSWORD '...';
    CREATE ROLE payroll_app LOGIN PASSWORD '7iPVDWhhv4reUtgLiYX6NojvTpT!' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO payroll_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO payroll_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO payroll_app;
-- Tables created by future migrations get the same grants automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO payroll_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO payroll_app;

-- Bookkeeping and catalogue tables the app must never write.
REVOKE ALL ON "_prisma_migrations" FROM payroll_app;
REVOKE INSERT, UPDATE, DELETE ON "Permission" FROM payroll_app;   -- synced by the seed script (owner)

-- 2. Context helpers ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_tenant() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '') $$;

CREATE OR REPLACE FUNCTION app_is_platform() RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('app.platform', true), '') = 'on' $$;

-- 3. Tenant tables: rows visible/writable only for the current tenant (or platform mode) ---------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Subscription', 'User', 'Role', 'RolePermission', 'UserRole', 'Invitation', 'SupportSession',
    'AuditLog', 'Employee', 'SalaryStructure', 'AttendanceRecord', 'LeaveType', 'LeaveBalance',
    'LeaveRequest', 'PayrollRun', 'Payslip'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (app_is_platform() OR "companyId" = app_tenant())
         WITH CHECK (app_is_platform() OR "companyId" = app_tenant())', t);
  END LOOP;
END
$$;

-- Company: a tenant sees only its own row.
ALTER TABLE "Company" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Company"
  USING (app_is_platform() OR "id" = app_tenant())
  WITH CHECK (app_is_platform() OR "id" = app_tenant());

-- 4. Platform tables: everyone may read; only platform mode may write --------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Plan', 'StatutoryConfig'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY platform_read ON %I FOR SELECT USING (true)', t);
    EXECUTE format('CREATE POLICY platform_write ON %I FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform())', t);
  END LOOP;
END
$$;

-- 5. Audit log is append-only -------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM payroll_app;

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only';
END
$$;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
