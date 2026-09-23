import { AppPage } from "@/components/app-shell";
import { DashboardMarkup, meta } from "@/components/app-pages/fleet-dashboard";

export const metadata = { title: meta.title, description: meta.description };

export default function Page() {
  return (
    <AppPage page="fleet-dashboard" skip={meta.skip}>
      <DashboardMarkup />
    </AppPage>
  );
}
