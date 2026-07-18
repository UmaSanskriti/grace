import { NavLink, useParams } from "react-router-dom";
import { Heart } from "lucide-react";
import { cn } from "../lib/utils";

export default function Nav() {
  const params = useParams();
  // Keep the dashboard / provider links useful during navigation by reusing
  // whatever id is in the URL, else fall back to demo placeholders.
  const caseId = params.caseId ?? "demo-case";
  const personaId = params.personaId ?? "A";

  const links = [
    { to: "/", label: "Consent & Enroll", end: true },
    { to: `/case/${caseId}`, label: "Case Dashboard", end: false },
    { to: `/demo-provider/${personaId}`, label: "Roleplayer Console", end: false },
  ];

  return (
    <header className="sticky top-0 z-20 border-b border-grace-border bg-grace-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-grace-accentSoft text-grace-accent">
            <Heart className="h-4 w-4" />
          </span>
          <div>
            <div className="text-sm font-semibold leading-tight">Grace</div>
            <div className="text-xs text-grace-muted leading-tight">
              Funeral-arrangements advocate · synthetic demo
            </div>
          </div>
        </div>
        <nav className="flex flex-wrap gap-1" aria-label="Demo navigation">
          {links.map((l) => (
            <NavLink
              key={l.label}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-grace-accent text-white"
                    : "text-grace-muted hover:bg-grace-accentSoft hover:text-grace-accent"
                )
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}
