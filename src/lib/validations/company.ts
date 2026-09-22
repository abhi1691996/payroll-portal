import { z } from "zod";
import { COMPANY_TYPES_WITH_CIN } from "@/lib/india";

const optional = (schema: z.ZodString) => schema.optional().or(z.literal(""));

export const clientSchema = z.object({
  name: z.string().trim().min(2, "Company name is required"),
  legalName: optional(z.string().trim()),
  pan: optional(z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "PAN must look like ABCDE1234F")),
  gstin: optional(
    z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "GSTIN must be 15 characters, e.g. 29ABCDE1234F1Z5")
  ),
  cin: optional(z.string().regex(/^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/, "CIN must be 21 characters, e.g. U12345KA2020PTC123456")),
  companyType: z.string().min(1, "Select the company type"),
  industry: optional(z.string().trim()),
  address: z.string().trim().min(5, "Registered address is required"),
  state: z.string().min(1, "State is required"),
  financialYearStart: z.coerce.number().int().min(1).max(12).default(4),
  planCode: z.string().min(1, "Choose a plan"),
  adminName: z.string().trim().min(2, "Admin name is required"),
  adminEmail: z.string().trim().toLowerCase().email("Enter a valid email address"),
  adminMobile: optional(z.string().regex(/^(\+91[\s-]?)?[6-9][0-9]{9}$/, "Enter a 10-digit Indian mobile number")),
});

export const clientSchemaChecked = clientSchema.superRefine((d, ctx) => {
  const isCompany = COMPANY_TYPES_WITH_CIN.includes(d.companyType);
  if (isCompany && !d.cin) ctx.addIssue({ code: "custom", path: ["cin"], message: "CIN is required for a company" });
  if (!isCompany && d.cin) ctx.addIssue({ code: "custom", path: ["cin"], message: "CIN applies only to Private / Public Limited companies" });
});

export type ClientInput = z.infer<typeof clientSchema>;

export const passwordSchema = z
  .string()
  .min(8, "Use at least 8 characters")
  .regex(/[A-Za-z]/, "Include at least one letter")
  .regex(/[0-9]/, "Include at least one number");
