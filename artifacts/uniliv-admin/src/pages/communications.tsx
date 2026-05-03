import * as React from "react"
import { PageHeader } from "@/components/page-header"
import { DataTable } from "@/components/data-table"
import { Button } from "@/components/ui/button"
import { Plus, Trash2 } from "lucide-react"
import { useGetAnnouncements, getGetAnnouncementsQueryKey, useCreateAnnouncement, useDeleteAnnouncement } from "@workspace/api-client-react"
import { format } from "date-fns"
import { FormModal } from "@/components/ui/form-modal"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { useForm } from "react-hook-form"
import { z } from "zod"
import { zodResolver } from "@hookform/resolvers/zod"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useQueryClient } from "@tanstack/react-query"

const schema = z.object({
  title: z.string().min(1, "Required"),
  content: z.string().min(1, "Required"),
  type: z.string().default("GENERAL"),
  propertyId: z.string().optional()
})

export default function Communications() {
  const queryClient = useQueryClient()
  const { data: res, isLoading } = useGetAnnouncements({} as any, { query: { queryKey: getGetAnnouncementsQueryKey({} as any) } })
  const createMutation = useCreateAnnouncement()
  const deleteMutation = useDeleteAnnouncement()

  const [isCreateOpen, setIsCreateOpen] = React.useState(false)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)

  const announcements = res?.data || []

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { title: "", content: "", type: "GENERAL" }
  })

  const onSubmit = (values: z.infer<typeof schema>) => {
    createMutation.mutate({ data: values }, {
      onSuccess: () => {
        setIsCreateOpen(false)
        form.reset()
        queryClient.invalidateQueries({ queryKey: getGetAnnouncementsQueryKey({} as any) })
      }
    })
  }

  const handleDelete = () => {
    if (!deleteId) return
    deleteMutation.mutate({ id: deleteId }, {
      onSuccess: () => {
        setDeleteId(null)
        queryClient.invalidateQueries({ queryKey: getGetAnnouncementsQueryKey({} as any) })
      }
    })
  }

  const columns = [
    { accessorKey: "title", header: "Title" },
    { accessorKey: "type", header: "Type" },
    { 
      accessorKey: "createdAt", 
      header: "Date",
      cell: ({row}: any) => {
        try {
          return format(new Date(row.original.createdAt), "dd MMM yyyy")
        } catch { return "" }
      }
    },
    {
      id: "actions",
      cell: ({row}: any) => (
        <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10" onClick={() => setDeleteId(row.original.id)}>
          <Trash2 className="w-4 h-4" />
        </Button>
      )
    }
  ]

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Communications" 
        subtitle="Manage announcements and notices sent to residents"
        action={
          <Button onClick={() => setIsCreateOpen(true)} className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            New Announcement
          </Button>
        }
      />

      <DataTable 
        columns={columns}
        data={announcements}
        isLoading={isLoading}
        searchKey="title"
        searchPlaceholder="Search announcements..."
      />

      <FormModal
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        title="Create Announcement"
        onSave={form.handleSubmit(onSubmit)}
        isSaving={createMutation.isPending}
      >
        <Form {...form}>
          <form className="space-y-4">
            <FormField control={form.control} name="title" render={({field}) => (
              <FormItem>
                <FormLabel>Title</FormLabel>
                <FormControl><Input {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="type" render={({field}) => (
              <FormItem>
                <FormLabel>Type</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="GENERAL">General Notice</SelectItem>
                    <SelectItem value="MAINTENANCE">Maintenance Alert</SelectItem>
                    <SelectItem value="EVENT">Event Invitation</SelectItem>
                    <SelectItem value="URGENT">Urgent Alert</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="content" render={({field}) => (
              <FormItem>
                <FormLabel>Message Content</FormLabel>
                <FormControl><Textarea className="h-32" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
          </form>
        </Form>
      </FormModal>

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={(op) => !op && setDeleteId(null)}
        title="Delete Announcement?"
        description="This action cannot be undone."
        onConfirm={handleDelete}
        isConfirming={deleteMutation.isPending}
      />
    </div>
  )
}
