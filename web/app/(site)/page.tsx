import { Header, SceneDots, Stage } from "@/components/chrome";
import { BuildProgress, Faq, HowItWorks, LineSits } from "@/components/more";
import { BotScene, BurnScene, ChainSees, Competition, Launch, Limits, TornHero } from "@/components/scenes";

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
        <Competition />
        <BurnScene />
        <BuildProgress />
        <Faq />
        <Launch />
        <SceneDots />
      </Stage>
    </>
  );
}
