import { MenuIcon, XIcon } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { Link, useInRouterContext } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function AppHeader({
  product,
  homeHref = "/",
  navigation,
  actions,
  navigationKey,
}: {
  product: string;
  homeHref?: string;
  navigation?: ReactNode;
  actions?: ReactNode;
  navigationKey?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuLocation, setMenuLocation] = useState(navigationKey);
  if (menuLocation !== navigationKey) {
    setMenuLocation(navigationKey);
    setMenuOpen(false);
  }
  const navigationId = useId();
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const hasRouter = useInRouterContext();
  const brandProps = {
    "aria-label": `Thruput ${product} homepage`,
    className: "flex min-h-12 shrink-0 items-center gap-2.5",
    children: (
      <div className="flex items-center gap-2 whitespace-nowrap text-[17px] font-medium min-[384px]:gap-3 min-[384px]:text-xl">
        <picture className="shrink-0">
          <source
            srcSet="/brand/stellar-dark.svg"
            media="(prefers-color-scheme: dark)"
          />
          <img
            src="/brand/stellar.svg"
            width="100"
            height="25"
            alt="Stellar"
            className="w-20 min-[384px]:w-25"
          />
        </picture>
        <span className="border-l pl-2 min-[384px]:pl-3">
          Thruput {product}
        </span>
      </div>
    ),
  };

  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex min-h-20 max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6 lg:min-h-22 lg:flex-nowrap lg:gap-6">
        {hasRouter ? (
          <Link to={homeHref} {...brandProps} />
        ) : (
          <a href={homeHref} {...brandProps} />
        )}
        {navigation ? (
          <div className="flex flex-1 justify-end lg:hidden">
            <Button
              ref={menuTrigger}
              type="button"
              variant="ghost"
              size="icon"
              aria-label={menuOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={menuOpen}
              aria-controls={navigationId}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {menuOpen ? (
                <XIcon aria-hidden="true" />
              ) : (
                <MenuIcon aria-hidden="true" />
              )}
            </Button>
          </div>
        ) : null}
        {navigation ? (
          <nav
            id={navigationId}
            aria-label="Main navigation"
            className={cn(
              "w-full flex-col gap-1 border-t pt-2 lg:flex lg:w-auto lg:flex-1 lg:flex-row lg:justify-end lg:border-0 lg:pt-0",
              menuOpen ? "flex" : "hidden",
            )}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("a"))
                setMenuOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setMenuOpen(false);
                menuTrigger.current?.focus();
              }
            }}
          >
            {navigation}
          </nav>
        ) : null}
        {actions ? (
          <div className="flex w-full flex-wrap items-center justify-end gap-2 border-t pt-2 empty:hidden lg:w-auto lg:border-0 lg:pt-0">
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}
