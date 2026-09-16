import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function LaunchSuccessActions({
  onReset,
  disabled,
  ammPoolLink,
  className,
}: {
  onReset: () => void;
  disabled: boolean;
  ammPoolLink: string | null;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Token creation actions"
      className={cn("flex flex-col gap-4", className)}
    >
      <Button
        className="min-h-12"
        variant="outline"
        onClick={onReset}
        disabled={disabled}
      >
        Create another token
      </Button>
      <Button className="min-h-12" variant="outline" asChild>
        <Link to="/my-tokens">View my tokens</Link>
      </Button>
      {ammPoolLink ? (
        <Button className="min-h-12" variant="outline" asChild>
          <a href={ammPoolLink}>Create AMM Pool</a>
        </Button>
      ) : null}
    </div>
  );
}
