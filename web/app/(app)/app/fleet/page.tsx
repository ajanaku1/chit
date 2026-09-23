import { AppPage } from "@/components/app-shell";
import { FleetMarkup, meta } from "@/components/app-pages/fleet";

export const metadata = { title: meta.title, description: meta.description };

export default function Page() {
  return (
    <AppPage page="fleet" skip={meta.skip}>
      <FleetMarkup />
    </AppPage>
  );
}
