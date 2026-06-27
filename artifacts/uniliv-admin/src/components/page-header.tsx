import * as React from "react"
import { ChevronRight } from "lucide-react"
import { Link } from "wouter"

export interface PageHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string
  subtitle?: string
  breadcrumbs?: { label: string; href?: string; onClick?: () => void }[]
  action?: React.ReactNode
}

export function PageHeader({ title, subtitle, breadcrumbs, action, className, ...props }: PageHeaderProps) {
  return (
    <div className={`flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 ${className}`} {...props}>
      <div>
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav className="flex items-center text-sm text-muted-foreground mb-2">
            {breadcrumbs.map((crumb, index) => (
              <React.Fragment key={crumb.label}>
                {index > 0 && <ChevronRight className="w-4 h-4 mx-1" />}
                {crumb.href ? (
                  <Link href={crumb.href} className="hover:text-primary transition-colors">
                    {crumb.label}
                  </Link>
                ) : crumb.onClick ? (
                  <button type="button" onClick={crumb.onClick} className="hover:text-primary transition-colors">
                    {crumb.label}
                  </button>
                ) : (
                  <span className="text-foreground font-medium">{crumb.label}</span>
                )}
              </React.Fragment>
            ))}
          </nav>
        )}
        <h1 className="text-2xl font-display font-bold tracking-tight text-primary">{title}</h1>
        {subtitle && <p className="text-muted-foreground mt-1">{subtitle}</p>}
      </div>
      {action && (
        <div className="flex items-center">
          {action}
        </div>
      )}
    </div>
  )
}
