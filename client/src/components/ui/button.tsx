import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-all duration-200 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-[#00C853] focus-visible:ring-[#00C853]/25 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-gradient-to-r from-[#00A855] to-[#007A30] text-white shadow-none hover:shadow-[0_12px_28px_rgba(0,122,48,0.24)] hover:brightness-105",
        destructive:
          "bg-destructive text-white shadow-none hover:bg-destructive/90 hover:shadow-[0_12px_26px_rgba(255,59,48,0.22)] focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border bg-white shadow-none hover:border-[#00C853] hover:bg-[#F9FFFC] hover:text-[#00A87A] hover:shadow-[0_10px_24px_rgba(10,31,26,0.08)] dark:bg-transparent dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground shadow-none hover:bg-secondary/80 hover:shadow-[0_10px_24px_rgba(10,31,26,0.08)]",
        ghost:
          "shadow-none hover:bg-accent dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-4 py-2 has-[>svg]:px-3",
        sm: "h-11 rounded-md gap-1.5 px-4 has-[>svg]:px-3",
        lg: "h-12 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-11",
        "icon-sm": "size-11",
        "icon-lg": "size-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
