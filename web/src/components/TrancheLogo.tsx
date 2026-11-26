import { cn } from "@/lib/utils";

interface TrancheLogoProps {
  className?: string;
  imgClassName?: string;
  priority?: boolean;
}

/**
 * Renders the official Tranche serrated ticket-stub logo mark (warm cream on obsidian).
 * Explicit width/height match natural 412x190 aspect ratio to prevent CLS.
 */
export function TrancheLogo({ className, imgClassName, priority = false }: TrancheLogoProps) {
  return (
    <span className={cn("inline-flex items-center select-none", className)}>
      <img
        src="/brand/tranche-mark-dark.png"
        alt="tranche"
        width={412}
        height={190}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        fetchPriority={priority ? "high" : "auto"}
        className={cn("block h-7 w-auto object-contain invert dark:invert-0", imgClassName)}
        draggable={false}
      />
    </span>
  );
}
