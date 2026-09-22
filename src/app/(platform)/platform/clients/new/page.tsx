import { requireSuperAdmin } from "@/server/rbac/guard";
import { withPlatform } from "@/server/tenancy/db";
import { PageHeader } from "@/components/ui";
import { NewClientForm } from "./new-client-form";

export default async function NewClientPage() {
  await requireSuperAdmin();
  const plans = await withPlatform((db) =>
    db.plan.findMany({
      where: { active: true },
      orderBy: { createdAt: "asc" },
      select: { code: true, name: true, maxEmployees: true },
    })
  );

  return (
    <div>
      <PageHeader
        back={{ href: "/platform/clients", label: "Clients" }}
        title="Add client"
        description="Creates the company with its settings, roles and default statutory rates, plus its first Company Admin login."
      />
      <NewClientForm plans={plans} />
    </div>
  );
}
