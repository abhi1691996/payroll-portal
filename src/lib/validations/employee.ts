import { z } from "zod";

export const employeeSchema = z.object({
  employeeCode: z.string().min(1, "Employee code is required"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("A valid login email is required"),
  personalEmail: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional().or(z.literal("")),
  panNumber: z
    .string()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "PAN must look like ABCDE1234F")
    .optional()
    .or(z.literal("")),
  aadhaarLast4: z
    .string()
    .regex(/^[0-9]{4}$/, "Enter the last 4 digits only")
    .optional()
    .or(z.literal("")),
  bankAccountNumber: z.string().optional().or(z.literal("")),
  bankIfsc: z
    .string()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "IFSC must look like ABCD0123456")
    .optional()
    .or(z.literal("")),
  department: z.string().optional().or(z.literal("")),
  designation: z.string().optional().or(z.literal("")),
  dateOfJoining: z.string().min(1, "Date of joining is required"),
  state: z.string().min(1, "State is required (used for Professional Tax slabs)"),
  taxRegime: z.enum(["OLD", "NEW"]).default("NEW"),
});

export type EmployeeFormValues = z.infer<typeof employeeSchema>;

export const salaryStructureSchema = z.object({
  effectiveFrom: z.string().min(1, "Effective date is required"),
  ctcAnnual: z.coerce.number().positive("CTC must be greater than 0"),
  basicMonthly: z.coerce.number().nonnegative(),
  hraMonthly: z.coerce.number().nonnegative(),
  specialAllowance: z.coerce.number().nonnegative(),
  otherAllowances: z.coerce.number().nonnegative().default(0),
  employerPfOptIn: z.coerce.boolean().default(true),
});

export type SalaryStructureFormValues = z.infer<typeof salaryStructureSchema>;
