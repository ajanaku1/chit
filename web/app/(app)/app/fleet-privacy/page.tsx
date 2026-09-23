import { AppPage } from "@/components/app-shell";
import { PrivacyMarkup, meta } from "@/components/app-pages/fleet-privacy";

export const metadata = { title: meta.title, description: meta.description };

export default function Page() {
  return (
    <AppPage page="fleet-privacy" skip={meta.skip}>
      <PrivacyMarkup />
    </AppPage>
  );
}
