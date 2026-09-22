"use client";

import Link from "next/link";
import { startTransition, useActionState, useState, type FormEvent } from "react";
import { CopyField } from "@/components/copy-field";
import { Icon } from "@/components/icons";
import { Alert, Card, CardHeader, Field, TextInput, buttonClass, inputClass } from "@/components/ui";
import { COMPANY_TYPES, COMPANY_TYPES_WITH_CIN, INDIAN_STATES, MONTHS } from "@/lib/india";
import { createClient } from "../actions";
import { INITIAL_CLIENT_STATE } from "../state";

interface PlanOption {
  code: string;
  name: string;
  maxEmployees: number | null;
}

export function NewClientForm({ plans }: { plans: PlanOption[] }) {
  const [state, action, pending] = useActionState(createClient, INITIAL_CLIENT_STATE);
  const err = state.fieldErrors ?? {};
  const [companyType, setCompanyType] = useState("");
  const hasCin = COMPANY_TYPES_WITH_CIN.includes(companyType);

  // Submit through our own handler instead of <form action>: React 19 clears uncontrolled fields after
  // a Server Action, which would wipe everything the admin typed whenever the server rejects one value.
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => action(data));
  }

  if (state.status === "created") {
    return (
      <Card className="max-w-2xl space-y-5">
        <div className="flex items-start gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-emerald-50 text-emerald-600">
            <Icon name="check" />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-ink">{state.companyName} is ready</h2>
            <p className="text-sm text-ink-soft">
              The company, its settings, roles and default statutory rates have been set up. Send the link below to{" "}
              <b className="font-medium text-ink">{state.adminEmail}</b> so they can choose a password and sign in.
            </p>
          </div>
        </div>
        <CopyField value={state.inviteLink!} label="Invitation link" />
        <Alert tone="warning">
          This link is shown <b>once</b> and expires in {state.expiresInDays} days. If it is lost, open the client and
          issue a new one.
        </Alert>
        <div className="flex gap-3">
          <Link href={`/platform/clients/${state.companyId}`} className={buttonClass("primary")}>
            View client
          </Link>
          <Link href="/platform/clients/new" className={buttonClass("secondary")}>
            Add another
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <form onSubmit={onSubmit} className="max-w-3xl space-y-6">
      {state.status === "error" && state.message && <Alert tone="error">{state.message}</Alert>}

      <Card>
        <CardHeader title="Company" description="The client's registered identity." />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput label="Company name" name="name" required error={err.name} />
          <TextInput label="Legal name" name="legalName" error={err.legalName} hint="If different from the trading name." />
          <TextInput label="PAN" name="pan" placeholder="ABCDE1234F" error={err.pan} />
          <TextInput label="GSTIN" name="gstin" placeholder="29ABCDE1234F1Z5" error={err.gstin} />
          <Field label="Company type" error={err.companyType} hint="Decides which registration numbers apply.">
            <select name="companyType" required value={companyType} onChange={(e) => setCompanyType(e.target.value)} className={inputClass}>
              <option value="" disabled>Select…</option>
              {COMPANY_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
          {hasCin && (
            <TextInput label="CIN" name="cin" required placeholder="U12345KA2020PTC123456" error={err.cin} hint="21-character Corporate Identification Number." />
          )}
          <TextInput label="Industry" name="industry" error={err.industry} placeholder="e.g. Manufacturing, IT services" />
          <Field label="State" error={err.state} hint="Used for Professional Tax.">
            <select name="state" required defaultValue="" className={inputClass}>
              <option value="" disabled>
                Select…
              </option>
              {INDIAN_STATES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Registered address" error={err.address} className="sm:col-span-2">
            <textarea name="address" required rows={2} className={inputClass} />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Payroll & plan" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Financial year starts">
            <select name="financialYearStart" defaultValue="4" className={inputClass}>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Payroll frequency" hint="Payroll currently runs monthly.">
            <select disabled defaultValue="MONTHLY" className={inputClass}>
              <option value="MONTHLY">Monthly</option>
            </select>
          </Field>
          <Field label="Plan" error={err.planCode}>
            <select name="planCode" defaultValue={plans.find((p) => p.code === "TRIAL")?.code ?? plans[0]?.code} className={inputClass}>
              {plans.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name} {p.maxEmployees ? `(up to ${p.maxEmployees})` : "(unlimited)"}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Company Admin"
          description="The first login for this company. They receive an invitation link and set their own password."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput label="Full name" name="adminName" required error={err.adminName} />
          <TextInput label="Email" name="adminEmail" type="email" required error={err.adminEmail} hint="This becomes their login." />
          <TextInput label="Mobile" name="adminMobile" type="tel" error={err.adminMobile} placeholder="9876543210" />
        </div>
      </Card>

      <div className="flex gap-3">
        <button type="submit" disabled={pending} className={buttonClass("primary")}>
          <Icon name="plus" className="size-4" />
          {pending ? "Creating…" : "Create client"}
        </button>
        <Link href="/platform/clients" className={buttonClass("ghost")}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
