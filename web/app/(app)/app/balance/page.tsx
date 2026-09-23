import { AppPage } from "@/components/app-shell";
import { BalanceMarkup, meta } from "@/components/app-pages/balance";

export const metadata = { title: meta.title, description: meta.description };

export default function Page() {
  return (
    <AppPage page="balance" skip={meta.skip}>
      <BalanceMarkup />
    </AppPage>
  );
}
