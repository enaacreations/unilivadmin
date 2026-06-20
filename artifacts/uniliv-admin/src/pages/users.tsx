import * as React from "react"
import {
  useGetUsers,
  getGetUsersQueryKey,
  useCreateUser,
  useGetProperties,
  getGetPropertiesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { FormModal } from "@/components/ui/form-modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Combobox } from "@/components/ui/combobox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePermissions } from "@/lib/use-permissions";
import { useToast } from "@/hooks/use-toast";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";

const USER_ROLES = [
  "SUPER_ADMIN", "HR_MANAGER", "OPERATIONS_MANAGER", "PROCUREMENT_MANAGER",
  "KITCHEN_MANAGER", "PROJECTS_MANAGER", "PROPERTY_ACQUISITION", "FINANCE",
  "SALES_EXECUTIVE", "WARDEN", "VENDOR_RESTRICTED", "AUDIT_READONLY",
];
const roleLabel = (r: string) => r.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function InviteUserModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const createMut = useCreateUser();
  const { data: propsRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } });
  const properties = (propsRes as any)?.data || [];

  const empty = { name: "", email: "", phone: "", password: "", role: "WARDEN", propertyId: "" };
  const [form, setForm] = React.useState(empty);
  React.useEffect(() => { if (open) setForm(empty); }, [open]);

  const propertyOptions = properties.map((p: any) => ({ value: p.id, label: p.name }));

  const onSave = async () => {
    if (!form.name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; }
    if (!form.email.trim()) { toast({ title: "Email is required", variant: "destructive" }); return; }
    if (form.password.length < 6) { toast({ title: "Password must be at least 6 characters", variant: "destructive" }); return; }
    try {
      await createMut.mutateAsync({
        data: {
          name: form.name,
          email: form.email,
          phone: form.phone || undefined,
          password: form.password,
          role: form.role,
          propertyId: form.propertyId || undefined,
        },
      });
      toast({ title: "User invited" });
      qc.invalidateQueries({ queryKey: getGetUsersQueryKey() });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed to invite user", variant: "destructive" });
    }
  };

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title="Invite User"
      onSave={onSave}
      isSaving={createMut.isPending}
      saveLabel="Send Invite"
    >
      <div className="space-y-4">
        <div>
          <Label>Full Name *</Label>
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} data-testid="input-user-name" />
        </div>
        <div>
          <Label>Email *</Label>
          <Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} data-testid="input-user-email" />
        </div>
        <div>
          <Label>Phone</Label>
          <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
        </div>
        <div>
          <Label>Temporary Password *</Label>
          <Input type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} data-testid="input-user-password" />
        </div>
        <div>
          <Label>Role</Label>
          <Select value={form.role} onValueChange={(v) => setForm((f) => ({ ...f, role: v }))}>
            <SelectTrigger data-testid="select-user-role"><SelectValue /></SelectTrigger>
            <SelectContent>{USER_ROLES.map((r) => <SelectItem key={r} value={r}>{roleLabel(r)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <Label>Property (optional)</Label>
          <Combobox
            options={propertyOptions}
            value={form.propertyId || null}
            onChange={(v) => setForm((f) => ({ ...f, propertyId: v || "" }))}
            placeholder="All properties"
            searchPlaceholder="Search properties…"
            allowClear
          />
        </div>
      </div>
    </FormModal>
  );
}

export default function Users() {
  const { can } = usePermissions();
  const canCreate = can("USERS", "create");
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const { data: usersRes, isLoading } = useGetUsers(undefined, { query: { queryKey: getGetUsersQueryKey() } });

  const users = usersRes?.data || [];

  const columns = [
    {
      accessorKey: "name",
      header: "User",
      cell: ({ row }: any) => (
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-display font-medium text-xs">
            {row.original.name.substring(0, 2).toUpperCase()}
          </div>
          <div>
            <div className="font-medium text-primary">{row.original.name}</div>
            <div className="text-xs text-muted-foreground">{row.original.email}</div>
          </div>
        </div>
      )
    },
    {
      accessorKey: "role",
      header: "Role",
      cell: ({ row }: any) => (
        <Badge variant="outline" className={row.original.role === 'ADMIN' ? "border-accent text-accent" : ""}>
          {row.original.role}
        </Badge>
      )
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }: any) => <StatusBadge status={row.original.isActive ? 'ACTIVE' : 'INACTIVE'} />
    },
    {
      accessorKey: "lastLogin",
      header: "Last Active",
      cell: ({ row }: any) => (
        <span className="text-sm text-muted-foreground">
          {row.original.lastLogin ? formatDistanceToNow(new Date(row.original.lastLogin), { addSuffix: true }) : 'Never'}
        </span>
      )
    }
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users & Roles"
        subtitle="Manage administrative access and permissions"
        action={
          canCreate ? (
            <Button onClick={() => setInviteOpen(true)} data-testid="button-invite-user">
              <Plus className="w-4 h-4 mr-2" />
              Invite User
            </Button>
          ) : undefined
        }
      />

      <DataTable
        columns={columns}
        data={users}
        isLoading={isLoading}
        searchKey="name"
        searchPlaceholder="Search users..."
      />

      {canCreate && <InviteUserModal open={inviteOpen} onOpenChange={setInviteOpen} />}
    </div>
  );
}
