import * as React from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { ResponsiveContainer, LineChart, Line } from "recharts"

export interface StatCardProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string
  value: string | number
  icon: React.ElementType
  change?: number
  sparklineData?: any[]
  sparklineKey?: string
}

export function StatCard({ 
  title, 
  value, 
  icon: Icon, 
  change, 
  sparklineData, 
  sparklineKey = "value",
  className, 
  ...props 
}: StatCardProps) {
  return (
    <Card className={cn("overflow-hidden", className)} {...props}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
          <Icon className="h-4 w-4 text-primary" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-display font-bold">{value}</div>
        
        {change !== undefined && (
          <p className="text-xs flex items-center mt-1">
            <span className={cn("flex items-center", change >= 0 ? "text-success" : "text-destructive")}>
              {change >= 0 ? <ArrowUpIcon className="h-3 w-3 mr-1" /> : <ArrowDownIcon className="h-3 w-3 mr-1" />}
              {Math.abs(change)}%
            </span>
            <span className="text-muted-foreground ml-1">from last month</span>
          </p>
        )}

        {sparklineData && (
          <div className="h-[40px] mt-4 -mx-4 mb-[-1rem]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sparklineData}>
                <Line 
                  type="monotone" 
                  dataKey={sparklineKey} 
                  stroke="var(--accent)" 
                  strokeWidth={2} 
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
