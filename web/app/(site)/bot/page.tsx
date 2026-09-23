import { Header, SceneDots, Stage } from "@/components/chrome";
import { Keypad, Once, Readings, SessionKey } from "@/components/botpage";
import { BotScene, Launch } from "@/components/scenes";

export const metadata = { title: "Chit · the bot" };

export default function BotPage() {
  return (
    <>
      <Header current="/bot" />
      <Stage>
        <BotScene hero />
        <Keypad />
        <Readings />
        <SessionKey />
        <Once />
        <Launch tone="void" />
        <SceneDots />
      </Stage>
    </>
  );
}
