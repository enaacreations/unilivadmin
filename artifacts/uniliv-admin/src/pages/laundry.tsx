import * as React from "react"
import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/ui/empty-state"
import { WashingMachine } from "lucide-react"
import { Button } from "@/components/ui/button"

export default function Laundry() {
  return (
    <div className="space-y-6 h-[calc(100vh-120px)] flex flex-col">
      <PageHeader 
        title="Laundry Operations" 
        subtitle="Manage laundry batches, vendor collections, and deliveries"
      />
      
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          icon={WashingMachine}
          title="Laundry Module Coming Soon"
          description="This module is currently under development. You will soon be able to track laundry collections and deliveries across all properties."
          action={
            <Button variant="outline" disabled>
              Join Waitlist
            </Button>
          }
        />
      </div>
    </div>
  )
}
