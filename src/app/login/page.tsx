import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { withPlatform } from "@/server/tenancy/db";
import { AuthError } from "next-auth";
import { Icon } from "@/components/icons";
import { Alert, SubmitButton, TextInput } from "@/components/ui";

const HIGHLIGHTS = [
  "Salary structures, PF / ESI / PT and TDS handled for you",
  "Bulk-upload employees, salaries and attendance from a spreadsheet",
  "Payslip PDFs and statutory CSVs, ready for your CA",
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string; accepted?: string }>;
}) {
  const { callbackUrl, error, accepted } = await searchParams;

  async function authenticate(formData: FormData) {
    "use server";
    const email = formData.get("email");
    const password = formData.get("password");
    const destination = formData.get("callbackUrl");

    try {
      // Sign in first (sets the session cookie), then pick the right portal: a chained redirect
      // through /dashboard would leave a Super Admin on the wrong URL.
      await signIn("credentials", { email, password, redirect: false });
    } catch (err) {
      if (err instanceof AuthError) {
        redirect(`/login?error=invalid&callbackUrl=${encodeURIComponent(String(destination ?? ""))}`);
      }
      throw err;
    }

    const account = await withPlatform((db) =>
      db.user.findUnique({ where: { email: String(email).trim().toLowerCase() }, select: { platformRole: true } })
    );
    if (account?.platformRole === "SUPER_ADMIN") redirect("/platform");
    // Only same-site paths are honoured as a post-login destination (no open redirect).
    const safe = typeof destination === "string" && destination.startsWith("/") && !destination.startsWith("//");
    redirect(safe && !destination.startsWith("/platform") ? destination : "/dashboard");
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <aside className="relative hidden overflow-hidden bg-brand-950 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div
          className="pointer-events-none absolute -right-32 -top-32 size-[28rem] rounded-full bg-brand-600/30 blur-3xl"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute -bottom-40 -left-24 size-[26rem] rounded-full bg-violet-500/20 blur-3xl"
          aria-hidden
        />
        <div className="relative flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-xl font-bold shadow-lg shadow-brand-900/40">
            ₹
          </span>
          <span className="text-lg font-semibold">Payroll Portal</span>
        </div>

        <div className="relative max-w-md">
          <h2 className="text-4xl font-semibold leading-tight tracking-tight">
            Payroll that runs itself — <span className="text-brand-300">accurately.</span>
          </h2>
          <ul className="mt-8 space-y-4">
            {HIGHLIGHTS.map((h) => (
              <li key={h} className="flex gap-3 text-brand-100/90">
                <Icon name="shield" className="mt-0.5 size-5 text-brand-300" />
                {h}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-sm text-brand-200/60">Built for small and medium businesses in India.</p>
      </aside>

      <main className="flex items-center justify-center px-4 py-12">
        <div className="fade-up w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-xl font-bold text-white">
              ₹
            </span>
            <span className="text-lg font-semibold text-ink">Payroll Portal</span>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight text-ink">Welcome back</h1>
          <p className="mt-1 text-sm text-ink-soft">Sign in to continue</p>

          {accepted && !error && (
            <div className="mt-6">
              <Alert tone="success">Your password is set. Sign in to continue.</Alert>
            </div>
          )}

          {error && (
            <div className="mt-6">
              <Alert tone="error">Invalid email or password.</Alert>
            </div>
          )}

          <form action={authenticate} className="mt-6 space-y-4">
            <input type="hidden" name="callbackUrl" value={callbackUrl ?? ""} />
            <TextInput label="Email" name="email" type="email" required />
            <TextInput label="Password" name="password" type="password" required />
            <div className="pt-2 [&>button]:w-full">
              <SubmitButton>Sign in</SubmitButton>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
