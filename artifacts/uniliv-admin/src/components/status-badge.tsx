import * as React from "react"
import { Badge } from "@/components/ui/badge"

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  status: string
}

export function StatusBadge({ status, className, ...props }: StatusBadgeProps) {
  const normalizedStatus = status?.toUpperCase() || "UNKNOWN";
  
  let variant: "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" = "secondary";
  
  if (["RESOLVED", "ACTIVE", "COMPLETED", "APPROVED", "DELIVERED", "PAID", "PICKED_UP", "READY", "ON_TIME"].includes(normalizedStatus)) {
    variant = "success";
  } else if (["OPEN", "NEW", "DRAFT", "RECEIVED", "LOW", "NORMAL", "PLACED", "DISPATCHED"].includes(normalizedStatus)) {
    variant = "info";
  } else if (["BREACH", "HIGH", "CRITICAL", "FAILED", "REJECTED", "CANCELLED", "OVERDUE", "DAMAGED", "SLA_BREACH", "URGENT"].includes(normalizedStatus)) {
    variant = "destructive";
  } else if (["PENDING", "IN_PROGRESS", "IN_TRANSIT", "PROCESSING", "IN_WASH", "MEDIUM", "PREPARING"].includes(normalizedStatus)) {
    variant = "warning";
  } else if (["INACTIVE", "CLOSED", "ARCHIVED"].includes(normalizedStatus)) {
    variant = "secondary";
  }

  return (
    <Badge variant={variant} className={className} {...props}>
      {normalizedStatus.replace(/_/g, ' ')}
    </Badge>
  )
}
