import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-[12px] border border-border/90 bg-background/80 px-3.5 py-2 text-base text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-[border-color,background-color,box-shadow] duration-200 outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground/60 hover:border-foreground/25 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45 md:text-sm",
        "focus-visible:border-foreground/55 focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-foreground/10",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
