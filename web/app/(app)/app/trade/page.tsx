import { AppPage } from "@/components/app-shell";
import { TradeMarkup, meta } from "@/components/app-pages/trade";

export const metadata = { title: meta.title, description: meta.description };

export default function Page() {
  return (
    <AppPage page="trade" skip={meta.skip}>
      <TradeMarkup />
    </AppPage>
  );
}
