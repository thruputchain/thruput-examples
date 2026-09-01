import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;

export function SheetContent({
  className,
  children,
  side = "right",
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  readonly side?: "right" | "bottom";
}) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 bg-black/55 backdrop-blur-xs data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <SheetPrimitive.Content
        className={cn(
          "fixed flex flex-col gap-4 overflow-hidden border-border bg-panel text-foreground shadow-xl outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
          side === "bottom"
            ? "inset-x-0 bottom-0 max-h-[72dvh] rounded-t-lg border-t pr-[var(--safe-right)] pb-[max(1rem,var(--safe-bottom))] pl-[var(--safe-left)] data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom"
            : "inset-y-0 right-0 w-[min(26rem,90vw)] border-l pt-[var(--safe-top)] pr-[var(--safe-right)] pb-[var(--safe-bottom)] data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close asChild>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-[max(.75rem,var(--safe-top))] right-[max(.75rem,var(--safe-right))]"
            aria-label="Close sheet"
          >
            <X />
          </Button>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

export function SheetHeader(props: React.ComponentProps<"div">) {
  return <div className="flex flex-col gap-1 p-4 pr-14" {...props} />;
}

export function SheetTitle(
  props: React.ComponentProps<typeof SheetPrimitive.Title>,
) {
  return <SheetPrimitive.Title className="font-medium" {...props} />;
}

export function SheetDescription(
  props: React.ComponentProps<typeof SheetPrimitive.Description>,
) {
  return (
    <SheetPrimitive.Description
      className="text-sm text-muted-foreground"
      {...props}
    />
  );
}
