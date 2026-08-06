import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"

function Spinner({
  className,
  "aria-hidden": ariaHidden,
  ...props
}: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role={ariaHidden ? undefined : "status"}
      aria-label={ariaHidden ? undefined : "Loading"}
      aria-hidden={ariaHidden}
      className={cn("size-4 motion-safe:animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
