import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildEmployeeMasterSheet, type MasterSheetEmployee } from "./mastersheet";

const employee = (overrides: Partial<MasterSheetEmployee> = {}): MasterSheetEmployee => ({
  employeeCode: "EMP001",
  firstName: "Priya",
  lastName: "Sharma",
  gender: "FEMALE",
  dateOfBirth: new Date("1995-06-15"),
  maritalStatus: "MARRIED",
  bloodGroup: "O+",
  emergencyContactName: "Rahul Sharma",
  emergencyContactPhone: "9876543210",
  category: "WHITE_COLLAR",
  department: "Engineering",
  designation: "Developer",
  managerName: null,
  dateOfJoining: new Date("2022-01-10"),
  dateOfExit: null,
  status: "ACTIVE",
  state: "Karnataka",
  personalEmail: "priya@example.com",
  phone: "9999999999",
  loginEmail: "priya@acme.test",
  panNumber: "ABCDE1234F",
  aadhaarLast4: "1234",
  bankAccountNumber: "12345678",
  bankIfsc: "ABCD0123456",
  taxRegime: "NEW",
  currentSalary: {
    ctcAnnual: 600000,
    grossMonthly: 40000,
    employerPfOptIn: true,
    effectiveFrom: new Date("2022-01-10"),
    lines: [
      { code: "BASIC", name: "Basic", monthlyAmount: 20000, isBasic: true, taxable: true, includeInPf: true, includeInEsi: true, includeInPt: true, sortOrder: 1 },
      { code: "HRA", name: "HRA", monthlyAmount: 8000, isBasic: false, taxable: true, includeInPf: false, includeInEsi: true, includeInPt: true, sortOrder: 2 },
    ],
  },
  ...overrides,
});

describe("buildEmployeeMasterSheet", () => {
  it("writes one Employee Master row per employee and one Salary Components row per salary line", async () => {
    const buf = await buildEmployeeMasterSheet([employee(), employee({ employeeCode: "EMP002", firstName: "Rahul", currentSalary: null })]);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);

    const master = wb.getWorksheet("Employee Master")!;
    expect(master).toBeDefined();
    expect(master.rowCount).toBe(3); // header + 2 employees
    expect(master.getRow(1).getCell(1).value).toBe("Employee Code");
    expect(master.getRow(2).getCell(1).value).toBe("EMP001");
    expect(master.getRow(2).getCell(4).value).toBe("Female"); // gender, title-cased
    expect(master.getRow(3).getCell(1).value).toBe("EMP002");

    const components = wb.getWorksheet("Salary Components")!;
    expect(components).toBeDefined();
    // EMP001 has 2 salary lines, EMP002 has none (no current salary) -> 1 header + 2 rows
    expect(components.rowCount).toBe(3);
    expect(components.getRow(2).getCell(1).value).toBe("EMP001");
    expect(components.getRow(2).getCell(3).value).toBe("BASIC");
  });

  it("leaves salary columns blank for an employee with no current salary", async () => {
    const buf = await buildEmployeeMasterSheet([employee({ currentSalary: null })]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const master = wb.getWorksheet("Employee Master")!;
    // CTC Annual is column 26
    expect(master.getRow(2).getCell(26).value).toBeNull();
  });
});
