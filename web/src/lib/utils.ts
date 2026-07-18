export type ClassValue =
  | string
  | number
  | null
  | false
  | undefined
  | ClassValue[];

/** Minimal className joiner (clsx-style) — no external dependency. */
export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const walk = (v: ClassValue) => {
    if (!v && v !== 0) return;
    if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (typeof v === "string" || typeof v === "number") {
      out.push(String(v));
    }
  };
  inputs.forEach(walk);
  return out.join(" ");
}

/** Mask an E.164 phone to its last 4 digits (§9.7 data minimization). */
export function maskPhone(e164: string | null | undefined): string {
  if (!e164) return "—";
  const digits = e164.replace(/[^\d]/g, "");
  if (digits.length < 4) return "•••";
  return `•••••••${digits.slice(-4)}`;
}

/** Validate an E.164 phone (e.g. +14155550123). */
export function isValidE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value.trim());
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** Format a nullable amount; null/undefined render as "unknown" (INV-08). */
export function formatUSD(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "unknown";
  return USD.format(amount);
}
