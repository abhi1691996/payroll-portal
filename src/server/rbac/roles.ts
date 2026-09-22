import type { PermissionScope } from "@prisma/client";
import { PERMISSION_KEYS, type PermissionKey } from "./permissions";

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  grants: Partial<Record<PermissionKey, PermissionScope>>;
}

/**
 * Default roles copied into every company when it is created. Each company can then adjust or add
 * roles; these are only starting points.
 *
 * A user can hold several roles; the widest scope per permission wins (COMPANY > TEAM > OWN).
 * So a line manager normally holds MANAGER (team powers) AND EMPLOYEE (their own data).
 * MANAGER deliberately has no salary/payroll permissions.
 */
export const SYSTEM_ROLES: RoleTemplate[] = [
  {
    key: "COMPANY_ADMIN",
    name: "Company Admin",
    description: "Full access to everything in the company.",
    grants: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, "COMPANY"])) as RoleTemplate["grants"],
  },
  {
    key: "HR_MANAGER",
    name: "HR Manager",
    description: "Employees, attendance and leave. No salary or payroll.",
    grants: {
      "employee.read": "COMPANY",
      "employee.create": "COMPANY",
      "employee.update": "COMPANY",
      "employee.import": "COMPANY",
      "employee.offboard": "COMPANY",
      "attendance.read": "COMPANY",
      "attendance.write": "COMPANY",
      "attendance.import": "COMPANY",
      "leave.read": "COMPANY",
      "leave.approve": "COMPANY",
      "leave.manage": "COMPANY",
      "report.read": "COMPANY",
      "settings.read": "COMPANY",
    },
  },
  {
    key: "PAYROLL_MANAGER",
    name: "Payroll Manager",
    description: "Salary, payroll runs and payslips.",
    grants: {
      "employee.read": "COMPANY",
      "employee.salary.read": "COMPANY",
      "employee.salary.write": "COMPANY",
      "attendance.read": "COMPANY",
      "payroll.read": "COMPANY",
      "payroll.run": "COMPANY",
      "payroll.finalize": "COMPANY",
      "payslip.read": "COMPANY",
      "report.read": "COMPANY",
      "settings.read": "COMPANY",
    },
  },
  {
    key: "FINANCE_MANAGER",
    name: "Finance Manager",
    description: "Read-only view of payroll, payslips and reports.",
    grants: {
      "employee.read": "COMPANY",
      "payroll.read": "COMPANY",
      "payslip.read": "COMPANY",
      "report.read": "COMPANY",
    },
  },
  {
    key: "MANAGER",
    name: "Manager",
    description: "Sees and approves their own team's attendance and leave. No salary access.",
    grants: {
      "employee.read": "TEAM",
      "attendance.read": "TEAM",
      "attendance.write": "TEAM",
      "leave.read": "TEAM",
      "leave.approve": "TEAM",
    },
  },
  {
    key: "EMPLOYEE",
    name: "Employee",
    description: "Their own profile, attendance, leave and payslips.",
    grants: {
      "employee.read": "OWN",
      "attendance.read": "OWN",
      "leave.read": "OWN",
      "leave.request": "OWN",
      "resignation.request": "OWN",
      "payslip.read": "OWN",
    },
  },
];

export const ROLE_KEYS = SYSTEM_ROLES.map((r) => r.key);
