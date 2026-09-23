import { AppPage } from "@/components/app-shell";
import { SessionsMarkup, meta } from "@/components/app-pages/sessions";

export const metadata = { title: meta.title, description: meta.description };

export default function Page() {
  return (
    <AppPage page="sessions" skip={meta.skip}>
      <SessionsMarkup />
    </AppPage>
  );
}
