import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { PayrollBreakdown } from "@/lib/payroll-calculations";

const styles = StyleSheet.create({
  page: { padding: 32, fontSize: 10, fontFamily: "Helvetica" },
  header: { marginBottom: 16, borderBottom: 1, borderColor: "#cbd5e1", paddingBottom: 12 },
  companyName: { fontSize: 16, fontWeight: 700 },
  meta: { color: "#475569", marginTop: 2 },
  title: { fontSize: 12, fontWeight: 700, marginTop: 16, marginBottom: 6 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  label: { color: "#334155" },
  value: { fontWeight: 700 },
  divider: { borderBottom: 1, borderColor: "#e2e8f0", marginVertical: 8 },
  netPayBox: {
    marginTop: 16,
    padding: 12,
    backgroundColor: "#f1f5f9",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  netPayLabel: { fontSize: 12, fontWeight: 700 },
  netPayValue: { fontSize: 14, fontWeight: 700 },
});

function formatCurrency(value: number): string {
  return `Rs. ${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function PayslipDocument({
  companyName,
  companyAddress,
  employeeName,
  employeeCode,
  period,
  breakdown,
}: {
  companyName: string;
  companyAddress: string;
  employeeName: string;
  employeeCode: string;
  period: string;
  breakdown: PayrollBreakdown;
}) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.companyName}>{companyName}</Text>
          <Text style={styles.meta}>{companyAddress}</Text>
        </View>

        <Text style={styles.title}>Payslip — {period}</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Employee</Text>
          <Text style={styles.value}>{employeeName}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Employee code</Text>
          <Text style={styles.value}>{employeeCode}</Text>
        </View>
        {breakdown.lopDays > 0 && (
          <View style={styles.row}>
            <Text style={styles.label}>Loss of pay days</Text>
            <Text style={styles.value}>{breakdown.lopDays}</Text>
          </View>
        )}

        <View style={styles.divider} />

        <Text style={styles.title}>Earnings</Text>
        {breakdown.earningLines ? (
          breakdown.earningLines
            .filter((l) => l.amount !== 0 || l.code === "BASIC")
            .map((l) => (
              <View key={l.code} style={styles.row}>
                <Text style={styles.label}>{l.name}</Text>
                <Text>{formatCurrency(l.amount)}</Text>
              </View>
            ))
        ) : (
          <>
            <View style={styles.row}>
              <Text style={styles.label}>Basic</Text>
              <Text>{formatCurrency(breakdown.earnings.basic)}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>HRA</Text>
              <Text>{formatCurrency(breakdown.earnings.hra)}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Special allowance</Text>
              <Text>{formatCurrency(breakdown.earnings.specialAllowance)}</Text>
            </View>
            {breakdown.earnings.otherAllowances > 0 && (
              <View style={styles.row}>
                <Text style={styles.label}>Other allowances</Text>
                <Text>{formatCurrency(breakdown.earnings.otherAllowances)}</Text>
              </View>
            )}
          </>
        )}
        <View style={styles.row}>
          <Text style={{ ...styles.label, fontWeight: 700 }}>Gross pay</Text>
          <Text style={styles.value}>{formatCurrency(breakdown.grossPay)}</Text>
        </View>

        <View style={styles.divider} />

        <Text style={styles.title}>Deductions</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Provident Fund</Text>
          <Text>{formatCurrency(breakdown.employeeDeductions.providentFund)}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>ESI</Text>
          <Text>{formatCurrency(breakdown.employeeDeductions.esi)}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Professional Tax</Text>
          <Text>{formatCurrency(breakdown.employeeDeductions.professionalTax)}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>TDS</Text>
          <Text>{formatCurrency(breakdown.employeeDeductions.tds)}</Text>
        </View>
        <View style={styles.row}>
          <Text style={{ ...styles.label, fontWeight: 700 }}>Total deductions</Text>
          <Text style={styles.value}>{formatCurrency(breakdown.totalDeductions)}</Text>
        </View>
        {breakdown.otherDeductionLines && breakdown.otherDeductionLines.length > 0 && (
          <>
            {breakdown.otherDeductionLines.map((l) => (
              <View key={l.code} style={styles.row}>
                <Text style={styles.label}>{l.name}</Text>
                <Text>{formatCurrency(l.amount)}</Text>
              </View>
            ))}
            <View style={styles.row}>
              <Text style={{ ...styles.label, fontWeight: 700 }}>Total deducted</Text>
              <Text style={styles.value}>
                {formatCurrency(breakdown.totalDeductions + breakdown.otherDeductionLines.reduce((s, l) => s + l.amount, 0))}
              </Text>
            </View>
          </>
        )}

        <View style={styles.netPayBox}>
          <Text style={styles.netPayLabel}>Net pay</Text>
          <Text style={styles.netPayValue}>{formatCurrency(breakdown.netPay)}</Text>
        </View>

        <View style={styles.divider} />
        <Text style={styles.title}>Employer contributions (for reference)</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Provident Fund</Text>
          <Text>{formatCurrency(breakdown.employerContributions.providentFund)}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>ESI</Text>
          <Text>{formatCurrency(breakdown.employerContributions.esi)}</Text>
        </View>
      </Page>
    </Document>
  );
}
