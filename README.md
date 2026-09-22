# Payroll Portal

Multi-tenant payroll SaaS for small/medium businesses in India. Three levels of users:
**Super Admin** (platform owner) -> **Company** users (admin, HR, payroll, finance, managers) ->
**Employees**. Each company's data is completely isolated from every other company's.

Architecture, data model and the delivery plan live in [`docs/architecture.md`](docs/architecture.md).
Deploying to production: [`docs/deploy-vercel.md`](docs/deploy-vercel.md).
**Status: phase 1 (foundation) is done** - tenancy, RBAC, audit log, Postgres with Row-Level Security,
and a Super Admin portal where clients are added (with an invitation link for their admin), suspended
and re-activated. The company setup wizard, configurable salary components, the approval engine and the
rest follow in later phases.

## Getting started

Requires Node 20+ and Docker (for Postgres).

```bash
docker compose up -d                 # Postgres 16
cp .env.example .env                 # then set AUTH_SECRET
npm install
npx prisma migrate deploy            # schema + Row-Level Security policies
npm run db:seed -- --demo            # permissions, plans, Super Admin, two demo companies
npm run dev
```

Open http://localhost:3000. Seeded logins:

| Who | Login | Password |
| --- | --- | --- |
| Super Admin | `superadmin@platform.test` | `SuperAdmin@12345` |
| Acme admin | `admin@acme.test` | `Admin@12345` |
| Acme employees | `priya.sharma@acme.test`, `rahul.verma@acme.test` | `Employee@12345` |
| Globex admin | `admin@globex.test` | `Admin@12345` |

**Change these before using real data.** Every new company is created with prefilled statutory rates
(FY2024-25 India defaults) that its own admin can review and extend under **Settings -> Statutory
rates**. Rates are per company, so one company's change never affects another. Have your CA verify them
before real payroll.

### Coming from the old single-company SQLite version?

```bash
npm run db:legacy:generate                    # read-only client for the old schema
npm run db:seed                               # platform bootstrap (no demo companies)
npm run db:migrate-legacy -- prisma/dev.db    # imports it as tenant #1, ids and passwords preserved
```

The migration runs in one transaction, verifies row counts and payslip totals, and never modifies
the source file. The old schema and migrations are kept under `prisma/legacy/`.

## Clients and invitations

The Super Admin adds a client under **Platform -> Clients -> Add client**: company details, plan and the
first Company Admin. The company is created with its six roles, default leave types and statutory rates.
The admin receives a **one-time invitation link** (shown once; only its hash is stored; valid 7 days) to
choose their password. Until an email provider is configured, the Super Admin copies and sends the link.
Suspending a client immediately blocks all of its users. Set `APP_URL` in production so links use your
public address.

## Income-tax regime

Each employee has their own **old / new regime** setting (profile page, the Add employee form, or a
`taxRegime` column in the employee/salary CSV uploads). Payroll uses it for TDS from the next run;
finalized payslips keep the regime they were calculated with. Changes are audited.

## Employee offboarding

An employee's `status` is one of `ACTIVE`, `ON_LEAVE`, `SUSPENDED`, `RESIGNED` or `TERMINATED`. The last
two are kept out of the ordinary Directory and every operational picker (attendance, leave, the manager
dropdown) — see them under **Employees -> Separated**. Nothing is ever deleted: attendance, leave and
payslip history stay exactly where they were. All of this lives on the employee's own profile page, in
the **Offboarding** card (`src/server/employees/lifecycle.ts` + `.../employees/offboarding-actions.ts`).

- **Suspension** (`EmployeeSuspension`) — a date range, open-ended or not, set by HR/admin
  (`employee.offboard`). Unpaid: `computeLop` treats the *working* days inside it as loss of pay, same as
  an absence, but weekly offs inside a suspension stay untouched (the employee is still on the books).
  "End suspension" closes it as of a chosen day (defaults to yesterday, so it takes effect immediately);
  `toDate` is the *last* suspended day, so closing it "today" leaves today itself still unpaid.
- **Resignation** (`EmployeeSeparation`, `type: RESIGNATION`) — the employee applies from their own
  profile (`resignation.request`, OWN scope), or HR/admin record one on their behalf. It goes through the
  same generic approval engine as leave (`entityType: "RESIGNATION"`, reporting manager first, HR/admin
  override, submitted-by can't approve their own). The **notice period (days)** is editable at any time
  before the last working day, by HR/admin, before or after approval — editing it recomputes the last
  working day and keeps `Employee.dateOfExit` in sync. The employee (or HR/admin) can **withdraw** it
  any time before the last working day passes.
- **Termination** (`EmployeeSeparation`, `type: TERMINATION`) — an employer decision with no approval
  step; the effective date can be backdated, today, or in the future.
- Once a resignation is approved or a termination recorded, **`Employee.dateOfExit`** (the last paid day)
  is set immediately; payroll reads it directly, so a partial month is correctly prorated the moment it
  happens, regardless of when anyone next opens the app. The coarse `status` label, and being taken off
  the roster, catch up lazily the next time anything is loaded (`ensureLifecycleStatuses` — no scheduler,
  same idea as leave's `ensureAccruals`), which is what "removed from the employee list" actually means.
- **Payroll**: days after `dateOfExit` are unpaid *including* weekly offs (there's no employment for them
  to be part of) — unlike a suspension, where the full month stays the denominator and only the specific
  days are deducted. See `computeLop`'s `excludedDates` (suspension) and `employedThrough` (separation) in
  `src/lib/attendance/lop.ts`, and how `src/app/(dashboard)/payroll/runs/actions.ts` builds them.

## How tenant isolation works

Three independent layers, each of which is tested (`npm run test:int`):

1. **Tenant-scoped client** (`src/server/tenancy/db.ts`): every unit of work runs through
   `withTenant(companyId, db => ...)`, which forces `companyId = <tenant>` into every query and stamps
   it on every insert. Application code cannot import the raw Prisma client (ESLint blocks it).
2. **Composite foreign keys**: a row in company A cannot reference a record in company B.
3. **Postgres Row-Level Security**: the app connects as a non-owner role (`payroll_app`); policies
   refuse cross-tenant rows even if layers 1-2 had a bug.

Permissions, not role names, gate every page, action and route handler (`src/server/rbac/`). Every
business change writes to an append-only audit log in the same transaction
(`src/server/audit/`). Sessions carry identity only; roles and permissions are re-read from the
database on every request, so revocations apply immediately.

## Bulk upload (CSV)

Admins can load data from spreadsheets on every tab where it makes sense. Each upload is
**Check file → review preview → Import**; nothing is written until you press Import, and
rows with problems are skipped with a row-number and reason (the rest still import).

| Where | Upload | Notes |
| --- | --- | --- |
| Employees → Directory | Employees | Creates login + profile. Blank `tempPassword` generates one (shown once, downloadable). Existing codes/emails are skipped. |
| Employees → Salary structures | Salary & structure | CTC + Basic/HRA/allowances, PF opt-in, tax regime. Versioned: each row closes the previous structure the day before; `effectiveFrom` must be later than the current one. |
| Attendance | Monthly grid **or** daily list | Grid = one row per employee, columns `1…31` for the selected month. List = `employeeCode,date,status`. Codes: `P A HD HOL WO L`. Replaces existing entries for the same days; finalized months are rejected. |
| Leave | Leave requests, leave balances | Requests default to Approved (for history). Balances upsert per employee/type/year. |

Every upload has a **template** download (the attendance grid template is pre-filled with
your active employees) and an **export** of current data in the same shape, so you can
export → edit → re-upload. Dates accept `2025-04-01` or `01/04/2025` (day first). Save Excel
files as **CSV UTF-8**; `.xlsx` is not read directly. Limits: 4 MB per file (raised
`serverActions.bodySizeLimit` to 5 MB in `next.config.ts`).

Code lives in `src/lib/bulk/` (parsers, per-entity importers, templates/exports) and
`src/components/bulk-import.tsx` (UI); the single Server Action is
`src/app/(dashboard)/bulk/actions.ts`.

## Company settings (rules differ per company)

Nothing about pay, time or leave is hard-wired. Company Admin / HR configure it under **Settings**
(tabs: Company, Employees, Salary rules, Shifts, Attendance rules, Leave rules, Approval rules,
Compliance rules). A new company starts with editable defaults (`src/server/companies/defaults.ts`);
companies that existed earlier received the same defaults from the migration.

- **Salary rules** - pay components (Basic, HRA, ... anything the company invents) and salary
  structures built from them (fixed amount, % of Basic, % of CTC, or balance). Assigning a structure to
  an employee snapshots the resulting lines, so later edits to the structure never rewrite history.
- **Shifts** - shift master (start/end, break, late / early-leaving grace; a night shift simply ends
  before it starts). Employees can be assigned a shift; otherwise the company default is used.
- **Attendance rules** - working week (Working / Weekly off / Alternate, e.g. Saturday off on the 2nd and
  4th), holidays, what happens after the late grace, half-day and absent thresholds, overtime (tracked;
  paid only if the company's policy says so). Attendance is entered as **In / Out times**; the status
  is derived from the shift and these rules. "No attendance = Absent" is **off by default** so a company
  that has not started recording attendance does not see every day turn into loss of pay - switch it on
  once attendance is being kept for everyone.
- **Leave rules** - leave types (pick from Casual, Sick, Earned, Privilege, Maternity, Paternity,
  Comp Off, Loss of Pay, or your own) and, separately, leave policies (yearly entitlement, accrual,
  carry-forward, max balance, encashment flag). Balances are a **ledger** (opening, accrual, leave taken,
  adjustment, reversal); the balance is the sum of the ledger. Accruals are created on demand and are
  idempotent - there is no scheduler to run.
- **Apply for leave** - the form runs the same checks as submit (policy, holidays and weekly offs are not
  counted, clashes with existing leave, balance including pending requests) and shows them live.
- **Approval rules** - the generic approval engine; leave goes to the reporting manager (skipped if the
  employee has none) and can have more levels (role based). HR / admins can always decide.
  Nobody approves their own request. Each request keeps a snapshot of the levels it was submitted under.
- **CIN** is asked for only when the company type is Private / Public Limited.

Bulk upload covers the new areas too: salary (component columns come from your own components; template
is generated per company), attendance (monthly grid, or a daily list with `inTime` / `outTime`) and leave
balances.


## Database

PostgreSQL 16 (`docker-compose.yml`). Two connections, both in `.env`:

- `DATABASE_URL` - the running app, as the **non-owner** `payroll_app` role, so Row-Level Security applies.
- `DIRECT_URL` - the owner, used only by `prisma migrate` and the seed/migration scripts.

The `payroll_app` role is created by the RLS migration with a development password. **Rotate it in
production:** `ALTER ROLE payroll_app PASSWORD '...'`. New tenant tables must be added to the RLS list
(see `prisma/migrations/*_rls_and_grants`) and get composite foreign keys to their parents.

## Testing

```bash
npm test            # fast unit tests, no database
npm run test:int    # tenant-isolation suite against a throwaway `payroll_test` database (needs Postgres running)
```

Unit tests cover `src/lib/payroll-calculations.ts` — the payroll math itself — against
hand-computed fixtures, plus the CSV reader/writer and bulk-upload parsers
(`src/lib/csv.test.ts`, `src/lib/bulk/parse.test.ts`) and the RBAC rules (`src/server/rbac/context.test.ts`). `tests/engines.int.test.ts` covers company defaults, salary structures, the leave ledger and approval flow, attendance from in/out times (incl. night shift) and isolation of the new tables. `tests/offboarding.int.test.ts` covers suspension/resignation/termination, their payroll proration, the lazy roster sweep, and that history survives separation. `tests/tenant-isolation.int.test.ts` tries to cross the company boundary at all three layers and must fail every time. This is the highest-risk correctness area; verify any changes
to tax/PF/ESI logic against known numbers before trusting a real payroll run.

## Notes on statutory accuracy

- PF, ESI, Professional Tax, and TDS rates live in the per-company `StatutoryConfig` table
  (prefilled for every new company, editable by its admin under Settings → Statutory rates), not
  hardcoded, because they change periodically and vary by state.
- TDS here is a **monthly estimate** (this month's gross annualized × slabs), not the
  cumulative projected-income method real payroll software uses across the financial
  year, and it doesn't account for standard deduction or 80C/HRA exemptions. Treat it
  as directional; have your CA verify before relying on it for filing.
- Reports under `/reports` produce CSVs for manual/CA-assisted filing — nothing is
  submitted to EPFO/ESIC/Income Tax portals automatically.
