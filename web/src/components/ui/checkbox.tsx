import { Check } from "lucide-react";
import { cn } from "../../lib/utils";

export interface CheckboxProps {
  id?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({
  id,
  checked,
  onCheckedChange,
  disabled,
  className,
}: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors",
        checked
          ? "border-grace-accent bg-grace-accent text-white"
          : "border-grace-border bg-grace-surface",
        disabled && "cursor-not-allowed opacity-60",
        className
      )}
    >
      {checked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
    </button>
  );
}
