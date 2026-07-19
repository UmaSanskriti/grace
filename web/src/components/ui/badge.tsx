import * as React from "react";
import { cn } from "../../lib/utils";

type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "muted";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

const toneClasses: Record<Tone, string> = {
  neutral: "bg-grace-border text-grace-ink",
  accent: "bg-grace-accentSoft text-grace-accent",
  ok: "bg-grace-accentSoft text-grace-ok",
  warn: "bg-[#f4ecd2] text-grace-warn",
  danger: "bg-grace-dangerSoft text-grace-danger",
  muted: "bg-grace-bg text-grace-muted",
};

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
        toneClasses[tone],
        className
      )}
      {...props}
    />
  );
}
