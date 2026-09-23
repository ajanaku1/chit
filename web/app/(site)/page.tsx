import { Header, SceneDots, Stage } from "@/components/chrome";
import { BuildProgress, Faq, HowItWorks, LineSits } from "@/components/more";
import { BotScene, BurnScene, ChainSees, Launch, Limits, TornHero } from "@/components/scenes";

export default function Home() {
  return (
    <>
      <Header current="/" />
      <Stage>
        <TornHero />
        <HowItWorks />
        <ChainSees />
        <LineSits />
        <Limits />
        <BotScene />
        <BurnScene />
        <BuildProgress />
        <Faq />
        <Launch />
        <SceneDots />
      </Stage>
    </>
  );
}
