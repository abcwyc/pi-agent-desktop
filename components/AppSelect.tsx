"use client";

import { useId, type ComponentPropsWithoutRef } from "react";
import * as Select from "@radix-ui/react-select";
import { isImeComposing } from "@/lib/ime";

export interface AppSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

type AppSelectProps = Omit<ComponentPropsWithoutRef<typeof Select.Trigger>, "children" | "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly AppSelectOption[];
  "aria-label": string;
  name?: string;
  placeholder?: string;
};

/** All form option pickers share the app menu surface and Radix's focus model. */
export function AppSelect({ value, onValueChange, options, name, placeholder, className, disabled, ...props }: AppSelectProps) {
  // Radix reserves an empty item value. Keep the public form value unchanged.
  const emptyId = useId();
  let emptyValue = `empty-${emptyId}`;
  while (options.some((option) => option.value === emptyValue)) emptyValue += "_";
  const encode = (item: string) => item === "" ? emptyValue : item;
  const selected = options.find((option) => option.value === value);

  return (
    <Select.Root value={encode(value)} disabled={disabled} onValueChange={(next) => onValueChange(next === emptyValue ? "" : next)}>
      {name && <input type="hidden" name={name} value={value} />}
      <Select.Trigger {...props} disabled={disabled} className={["app-select-trigger", className].filter(Boolean).join(" ")}>
        <Select.Value>{selected?.label ?? placeholder ?? value}</Select.Value>
        <Select.Icon className="app-select-chevron">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m7 10 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="native-popover app-menu app-select-menu"
          position="popper"
          sideOffset={6}
          collisionPadding={8}
          aria-label={props["aria-label"]}
          onEscapeKeyDown={(event) => {
            if (isImeComposing(event)) event.preventDefault();
            event.stopPropagation();
          }}
        >
          <Select.Viewport className="app-select-viewport">
            {options.map((option) => (
              <Select.Item key={option.value} value={encode(option.value)} disabled={option.disabled} textValue={option.label} className="app-select-option">
                <span className="app-select-check" aria-hidden="true">
                  <Select.ItemIndicator><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m5 12 4 4L19 6" strokeLinecap="round" strokeLinejoin="round" /></svg></Select.ItemIndicator>
                </span>
                <Select.ItemText>{option.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
