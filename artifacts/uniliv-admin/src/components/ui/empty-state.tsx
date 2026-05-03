import * as React from "react"
import { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div 
      className={cn("flex flex-col items-center justify-center p-12 text-center rounded-lg border border-dashed bg-surface/50", className)} 
      {...props}
    >
      <div className="w-16 h-16 rounded-full bg-primary/5 flex items-center justify-center mb-6">
        <Icon className="w-8 h-8 text-primary/40" />
      </div>
      <h3 className="text-xl font-display font-semibold tracking-tight text-primary mb-2">{title}</h3>
      {description && (
        <p className="text-muted-foreground max-w-sm mb-6">
          {description}
        </p>
      )}
      {action && (
        <div>{action}</div>
      )}
    </div>
  )
}
