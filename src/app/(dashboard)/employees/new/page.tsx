import { Alert, Card, CardHeader, Field, PageHeader, SubmitButton, TextInput, LinkButton, inputClass } from "@/components/ui";
import { requirePermission } from "@/server/rbac/guard";
import { EMPLOYEE_CATEGORIES, GENDERS, MARITAL_STATUSES } from "@/lib/india";
import { createEmployee } from "../actions";

export default async function NewEmployeePage() {
  await requirePermission("employee.create", "COMPANY");
  return (
    <div className="max-w-3xl">
      <PageHeader
        back={{ href: "/employees", label: "Employees" }}
        title="Add employee"
        description="Creates the employee's login and profile. Set their salary structure afterwards from their profile."
        actions={
          <LinkButton href="/employees?bulk=1#bulk-upload" variant="secondary" icon="upload">
            Add many at once
          </LinkButton>
        }
      />

      <form action={createEmployee} className="space-y-6">
        <Card>
          <CardHeader title="Basic details" />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInput label="Employee code" name="employeeCode" placeholder="EMP101" hint="Leave blank to number automatically (switch on under Settings → Employees)." />
            <TextInput label="Date of joining" name="dateOfJoining" type="date" required />
            <TextInput label="First name" name="firstName" required />
            <TextInput label="Last name" name="lastName" hint="Optional." />
            <TextInput label="Department" name="department" />
            <TextInput label="Designation" name="designation" />
            <Field label="Category">
              <select name="category" defaultValue="WHITE_COLLAR" className={inputClass}>
                {EMPLOYEE_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </Field>
            <TextInput
              label="State"
              name="state"
              required
              placeholder="e.g. Karnataka"
              hint="Used to pick Professional Tax slabs."
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="Personal details" description="Optional, but useful for HR records, benefits and workplace safety." />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInput label="Date of birth" name="dateOfBirth" type="date" />
            <Field label="Gender">
              <select name="gender" defaultValue="" className={inputClass}>
                <option value="">Not specified</option>
                {GENDERS.map((g) => (
                  <option key={g.value} value={g.value}>{g.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Marital status">
              <select name="maritalStatus" defaultValue="" className={inputClass}>
                <option value="">Not specified</option>
                {MARITAL_STATUSES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </Field>
            <TextInput label="Blood group" name="bloodGroup" placeholder="e.g. O+" />
            <TextInput label="Emergency contact name" name="emergencyContactName" />
            <TextInput label="Emergency contact phone" name="emergencyContactPhone" />
          </div>
        </Card>

        <Card>
          <CardHeader title="Contact" />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInput label="Login email" name="email" type="email" required />
            <TextInput label="Personal email" name="personalEmail" type="email" />
            <TextInput label="Phone" name="phone" />
          </div>
        </Card>

        <Card>
          <CardHeader title="Statutory & bank" description="Optional now, but needed for TDS and salary transfers." />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInput label="PAN" name="panNumber" placeholder="ABCDE1234F" />
            <TextInput label="Aadhaar (last 4 digits)" name="aadhaarLast4" />
            <Field label="Income-tax regime" hint="The regime this employee has opted for. You can change it later from their profile.">
              <select name="taxRegime" defaultValue="NEW" className={inputClass}>
                <option value="NEW">New regime</option>
                <option value="OLD">Old regime</option>
              </select>
            </Field>
            <TextInput label="Bank account number" name="bankAccountNumber" />
            <TextInput label="Bank IFSC" name="bankIfsc" placeholder="ABCD0123456" />
          </div>
        </Card>

        <Card>
          <CardHeader title="First sign-in" />
          <TextInput
            label="Temporary password"
            name="tempPassword"
            required
            hint="At least 8 characters. Share it with the employee securely."
          />
          <div className="mt-4">
            <Alert tone="info">The employee signs in with the login email above and this password.</Alert>
          </div>
        </Card>

        <div className="flex gap-3">
          <SubmitButton icon="check">Create employee</SubmitButton>
          <LinkButton href="/employees" variant="ghost">
            Cancel
          </LinkButton>
        </div>
      </form>
    </div>
  );
}
