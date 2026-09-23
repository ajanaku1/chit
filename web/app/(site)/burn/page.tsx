import { Header, SceneDots, Stage } from "@/components/chrome";
import { BurnHero, BurnLog, Guards, Mechanism } from "@/components/burn";
import { Launch } from "@/components/scenes";

export const metadata = { title: "Chit · burn" };

export default function BurnPage() {
  return (
    <>
      <Header current="/burn" />
      <Stage>
        <BurnHero />
        <Mechanism />
        <BurnLog />
        <Guards />
        <Launch tone="void" />
        <SceneDots />
      </Stage>
    </>
  );
}
