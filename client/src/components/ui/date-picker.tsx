import * as React from "react";
import { CalendarDays } from "lucide-react";

import { Input } from "@/components/ui/input";

type DatePickerProps = {
  id?: string;
  value: string;
  min?: string;
  required?: boolean;
  disabled?: boolean;
  onValueChange: (value: string) => void;
};

function DatePicker({
  id,
  value,
  min,
  required,
  disabled,
  onValueChange,
}: DatePickerProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  function openPicker() {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.showPicker?.();
  }

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        id={id}
        type="date"
        value={value}
        min={min}
        required={required}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value)}
        className="pr-10 [&::-webkit-calendar-picker-indicator]:opacity-0"
      />
      <button
        type="button"
        onClick={openPicker}
        disabled={disabled}
        aria-label="Open date picker"
        className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 inline-flex w-10 cursor-pointer items-center justify-center disabled:cursor-not-allowed disabled:opacity-50"
      >
        <CalendarDays className="size-4" aria-hidden />
      </button>
    </div>
  );
}

export { DatePicker };
