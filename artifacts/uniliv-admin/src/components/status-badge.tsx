import * as React from "react"
import { Badge } from "@/components/ui/badge"

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  status: string
}

export function StatusBadge({ status, className, ...props }: StatusBadgeProps) {
  const normalizedStatus = status?.toUpperCase() || "UNKNOWN";
  
  let variant: "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" = "secondary";
  
  if (["RESOLVED", "ACTIVE", "COMPLETED", "APPROVED", "DELIVERED", "PAID"].includes(normalizedStatus)) {
    variant = "success";
  } else if (["OPEN", "NEW", "DRAFT"].includes(normalizedStatus)) {
    variant = "info";
  } else if (["BREACH", "HIGH", "CRITICAL", "FAILED", "REJECTED", "CANCELLED", "OVERDUE"].includes(normalizedStatus)) {
    variant = "destructive";
  } else if (["PENDING", "IN_PROGRESS", "IN_TRANSIT", "PROCESSING"].includes(normalizedStatus)) {
    variant = "warning";
  } else if (["INACTIVE", "CLOSED", "ARCHIVED"].includes(normalizedStatus)) {
    variant = "secondary";
  }

  return (
    <Badge variant={variant} className={className} {...props}>
      {status}
    </Badge>
  )
}
