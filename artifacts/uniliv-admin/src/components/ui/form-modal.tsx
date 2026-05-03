import * as React from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"

interface FormModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: React.ReactNode
  onSave?: () => void
  isSaving?: boolean
  saveLabel?: string
  cancelLabel?: string
  showFooter?: boolean
}

export function FormModal({
  open,
  onOpenChange,
  title,
  children,
  onSave,
  isSaving = false,
  saveLabel = "Save",
  cancelLabel = "Cancel",
  showFooter = true,
}: FormModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] h-full max-h-screen rounded-none top-0 right-0 translate-x-0 translate-y-0 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right flex flex-col gap-0 p-0 border-l sm:left-auto">
        <DialogHeader className="px-6 py-4 border-b border-border bg-card sticky top-0 z-10 shrink-0">
          <DialogTitle className="text-xl font-display text-primary">{title}</DialogTitle>
        </DialogHeader>
        
        <div className="flex-1 overflow-y-auto p-6 bg-surface">
          {children}
        </div>

        {showFooter && (
          <div className="px-6 py-4 border-t border-border bg-card sticky bottom-0 z-10 shrink-0 flex items-center justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              {cancelLabel}
            </Button>
            <Button 
              type="button" 
              onClick={onSave}
              disabled={isSaving}
            >
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {saveLabel}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
