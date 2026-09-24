/**
 * Permission catalogue. The single source of truth for what can be granted.
 *
 * Screens and actions ask for a PERMISSION ("leave.approve"), never for a role name. Roles are data
 * (Role + RolePermission tables) so each company can adjust them without code changes.
 * Synced to the `Permission` table by `npm run db:seed`.
 */
export const PERMISSIONS = {
  // Employees
  "employee.read": { module: "Employees", description: "View employee profiles" },
  "employee.create": { module: "Employees", description: "Add employees" },
  "employee.update": { module: "Employees", description: "Edit employee details" },
  "employee.import": { module: "Employees", description: "Bulk-upload employees" },
  "employee.salary.read": { module: "Employees", description: "View salary and salary structures" },
  "employee.salary.write": { module: "Employees", description: "Change salary and upload salary structures" },
  "employee.offboard": { module: "Employees", description: "Suspend, reinstate, terminate and decide resignations" },
  "resignation.request": { module: "Employees", description: "Apply for their own resignation" },
  "loan.request": { module: "Employees", description: "Apply for a loan or salary advance" },
  "loan.manage": { module: "Employees", description: "Approve, reject and process loan/advance deductions" },
  "tds.manage": { module: "Payroll", description: "Compute, revise and approve employee TDS" },

  // Attendance
  "attendance.read": { module: "Attendance", description: "View attendance" },
  "attendance.write": { module: "Attendance", description: "Mark and correct attendance" },
  "attendance.import": { module: "Attendance", description: "Bulk-upload attendance" },

  // Leave
  "leave.read": { module: "Leave", description: "View leave requests" },
  "leave.request": { module: "Leave", description: "Apply for leave" },
  "leave.approve": { module: "Leave", description: "Approve or reject leave" },
  "leave.manage": { module: "Leave", description: "Manage leave balances and upload leave data" },

  // Payroll
  "payroll.read": { module: "Payroll", description: "View payroll runs" },
  "payroll.run": { module: "Payroll", description: "Process payroll" },
  "payroll.finalize": { module: "Payroll", description: "Finalize payroll runs" },
  "payslip.read": { module: "Payroll", description: "View payslips" },

  // Reports & compliance
  "report.read": { module: "Reports", description: "Download statutory and payroll reports" },

  // Administration
  "settings.read": { module: "Settings", description: "View company settings" },
  "settings.write": { module: "Settings", description: "Change company settings" },
  "user.manage": { module: "Administration", description: "Create users and assign roles" },
  "role.manage": { module: "Administration", description: "Create and edit roles and permissions" },
  "audit.read": { module: "Administration", description: "View the audit log" },
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export function isPermissionKey(value: string): value is PermissionKey {
  return value in PERMISSIONS;
}
