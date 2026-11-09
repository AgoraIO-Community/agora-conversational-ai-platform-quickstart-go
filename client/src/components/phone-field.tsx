import * as React from "react";
import PhoneInput, {
  isValidPhoneNumber,
  type Country,
} from "react-phone-number-input";
import "react-phone-number-input/style.css";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export { isValidPhoneNumber };

export type PhoneFieldProps = {
  id?: string;
  value: string;
  onChange: (e164: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  /** Default country for parsing partial numbers (E.164 still required for submit). */
  defaultCountry?: Country;
};

export function PhoneField({
  id,
  value,
  onChange,
  disabled,
  invalid,
  defaultCountry = "US",
}: PhoneFieldProps) {
  return (
    <div
      className={cn(
        "phone-field w-full",
        invalid && "rounded-md ring-2 ring-destructive/45 ring-offset-2 ring-offset-background",
      )}
    >
      <PhoneInput
        international
        countryCallingCodeEditable={false}
        defaultCountry={defaultCountry}
        value={value || undefined}
        onChange={(v) => onChange(typeof v === "string" ? v : "")}
        inputComponent={Input}
        className="flex w-full items-stretch gap-2"
        disabled={disabled}
        limitMaxLength
        smartCaret
        numberInputProps={{
          id,
          "aria-invalid": invalid,
          autoComplete: "tel",
        }}
      />
    </div>
  );
}
