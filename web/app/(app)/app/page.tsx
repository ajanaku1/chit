import { redirect } from "next/navigation";

/* The app opens on the balance, as chit.tools/app has. */
export default function AppHome() {
  redirect("/app/balance");
}
