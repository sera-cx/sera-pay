import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type AdvancedSelectOption = {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
};

export type AdvancedSelectGroup = {
  label: string;
  options: AdvancedSelectOption[];
};

export function AdvancedSelect({
  value,
  onValueChange,
  options,
  groups,
  placeholder = "Select",
  disabled = false,
  className,
  triggerClassName,
  contentClassName,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options?: AdvancedSelectOption[];
  groups?: AdvancedSelectGroup[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
}) {
  const renderOption = (option: AdvancedSelectOption) => (
    <SelectItem key={option.value} value={option.value} className="min-h-11">
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        {option.icon ? <span className="shrink-0 text-base leading-none">{option.icon}</span> : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-gray-900">{option.label}</span>
          {option.description ? <span className="block truncate text-xs font-normal text-gray-400">{option.description}</span> : null}
        </span>
      </span>
    </SelectItem>
  );

  const flatOptions = options || groups?.flatMap((group) => group.options) || [];
  const selected = flatOptions.find((option) => option.value === value);

  return (
    <div className={cn("w-full", className)}>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger className={cn("h-11 w-full rounded-2xl border-gray-200 pr-3", triggerClassName)}>
          <SelectValue placeholder={placeholder}>
            {selected ? (
              <span className="flex min-w-0 items-center gap-2">
                {selected.icon ? <span className="shrink-0 text-base leading-none">{selected.icon}</span> : null}
                <span className="truncate">{selected.label}</span>
              </span>
            ) : null}
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="start" className={cn("w-[var(--radix-select-trigger-width)]", contentClassName)}>
          {groups?.map((group) => (
            <SelectGroup key={group.label}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.options.map(renderOption)}
            </SelectGroup>
          ))}
          {!groups ? flatOptions.map(renderOption) : null}
        </SelectContent>
      </Select>
    </div>
  );
}