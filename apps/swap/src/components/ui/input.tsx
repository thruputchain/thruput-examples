import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const inputVariants = cva(
  "w-full min-w-0 text-base outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "h-9 rounded-md border border-input bg-muted px-2.5 py-1 file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring disabled:bg-secondary aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive md:text-sm pointer-coarse:min-h-12",
        amount:
          "h-auto rounded-none border-0 bg-transparent p-0 font-mono text-3xl font-medium tracking-tight tabular-nums shadow-none placeholder:text-muted-foreground focus-visible:ring-0 sm:text-4xl",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Input({
  className,
  type,
  variant,
  ...props
}: React.ComponentProps<"input"> & VariantProps<typeof inputVariants>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(inputVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Input, inputVariants }
