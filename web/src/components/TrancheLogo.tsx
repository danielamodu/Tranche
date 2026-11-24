import { cn } from "@/lib/utils";

interface TrancheLogoProps {
  className?: string;
  imgClassName?: string;
}

/**
 * Renders the official Tranche serrated ticket-stub logo mark (warm cream on obsidian).
 */
export function TrancheLogo({ className, imgClassName }: TrancheLogoProps) {
  return (
    <span className={cn("inline-flex items-center select-none", className)}>
      <img
        src="/brand/tranche-mark-dark.png"
        alt="tranche"
        className={cn("block h-7 w-auto object-contain", imgClassName)}
        draggable={false}
      />
    </span>
  );
}
