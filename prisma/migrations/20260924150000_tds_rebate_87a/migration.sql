-- Section 87A rebate: record what was applied to each TdsComputation version, for the audit trail.
ALTER TABLE "TdsComputation" ADD COLUMN     "rebate87A" DECIMAL(14,2) NOT NULL DEFAULT 0;
