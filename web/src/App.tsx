import { Outlet } from "react-router-dom";
import Nav from "./components/Nav";

export default function App() {
  return (
    <div className="min-h-full">
      <Nav />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 pt-6 text-xs text-grace-muted">
        Synthetic hackathon demo. No real people, providers, prices, or death
        records. All data is fabricated to exercise Grace&rsquo;s intake,
        quoting, negotiation, and ranking logic.
      </footer>
    </div>
  );
}
