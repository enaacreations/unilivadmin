import * as React from "react"
import {
  useGetUsers,
  getGetUsersQueryKey,
  useCreateUser,
  useUpdateUser,
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { usePermissions } from "@/lib/use-permissions";
import { ROLE_PERMISSIONS } from "@/lib/permissions";
import { useToast } from "@/hooks/use-toast";
import { Plus, MoreHorizontal, Upload } from "lucide-react";
import { BulkUploadDialog, type BulkColumn } from "@/components/bulk-upload-dialog";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";

// Single source of truth for the full role list (incl. the 9 food roles).
// Keys of ROLE_PERMISSIONS cover every UserRole at runtime.
const USER_ROLES = Object.keys(ROLE_PERMISSIONS);
// Roles that are scoped to a single property and therefore require a propertyId.
const PROPERTY_SCOPED_ROLES = new Set(["UNIT_LEAD", "WARDEN"]);
const roleLabel = (r: string) => r.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// Column config for the bulk-upload template + header→key mapping. Keys match
// the backend's verbatim row object keys for POST /bulk/users.
const USER_BULK_COLUMNS: BulkColumn[] = [
  { key: "name", label: "name", required: true },
  { key: "email", label: "email", required: true },
  { key: "role", label: "role", required: true },
  { key: "propertyId", label: "propertyId" },
  { key: "designation", label: "designation" },
  { key: "phone", label: "phone" },
];

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
  const propertyRequired = PROPERTY_SCOPED_ROLES.has(form.role);

  const onSave = async () => {
    if (!form.name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; }
    if (!form.email.trim()) { toast({ title: "Email is required", variant: "destructive" }); return; }
    if (form.password.length < 6) { toast({ title: "Password must be at least 6 characters", variant: "destructive" }); return; }
    if (propertyRequired && !form.propertyId) { toast({ title: "Property is required for this role", variant: "destructive" }); return; }
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
          <Label>{propertyRequired ? "Property *" : "Property (optional)"}</Label>
          <Combobox
            options={propertyOptions}
            value={form.propertyId || null}
            onChange={(v) => setForm((f) => ({ ...f, propertyId: v || "" }))}
            placeholder={propertyRequired ? "Select a property" : "All properties"}
            searchPlaceholder="Search properties…"
            allowClear
          />
          {!propertyRequired && (
            <p className="text-xs text-muted-foreground mt-1">
              Org-wide / multi-scope roles don't need a single property here. Assign
              multi-property scope from Food &gt; Organization.
            </p>
          )}
        </div>
      </div>
    </FormModal>
  );
}

function EditUserModal({ user, open, onOpenChange }: { user: any; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const updateMut = useUpdateUser();
  const { data: propsRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } });
  const properties = (propsRes as any)?.data || [];
  const propertyOptions = properties.map((p: any) => ({ value: p.id, label: p.name }));

  const toForm = (u: any) => ({
    name: u?.name ?? "",
    email: u?.email ?? "",
    role: u?.role ?? "WARDEN",
    propertyId: u?.propertyId ?? "",
    designation: u?.designation ?? "",
    isActive: u?.isActive ?? true,
  });
  const [form, setForm] = React.useState(() => toForm(user));
  React.useEffect(() => { if (open) setForm(toForm(user)); }, [open, user]);

  const propertyRequired = PROPERTY_SCOPED_ROLES.has(form.role);

  const onSave = async () => {
    if (!form.name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; }
    if (!form.email.trim()) { toast({ title: "Email is required", variant: "destructive" }); return; }
    if (propertyRequired && !form.propertyId) { toast({ title: "Property is required for this role", variant: "destructive" }); return; }
    try {
      await updateMut.mutateAsync({
        id: user.id,
        // email + designation are accepted by the backend's WRITABLE_USER_FIELDS
        // even though the generated UpdateUserBody type omits them.
        data: {
          name: form.name,
          email: form.email,
          role: form.role,
          propertyId: form.propertyId || undefined,
          designation: form.designation || undefined,
          isActive: form.isActive,
        } as any,
      });
      toast({ title: "User updated" });
      qc.invalidateQueries({ queryKey: getGetUsersQueryKey() });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed to update user", variant: "destructive" });
    }
  };

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title="Edit User"
      onSave={onSave}
      isSaving={updateMut.isPending}
      saveLabel="Save Changes"
    >
      <div className="space-y-4">
        <div>
          <Label>Full Name *</Label>
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} data-testid="input-edit-user-name" />
        </div>
        <div>
          <Label>Email *</Label>
          <Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} data-testid="input-edit-user-email" />
        </div>
        <div>
          <Label>Designation</Label>
          <Input value={form.designation} onChange={(e) => setForm((f) => ({ ...f, designation: e.target.value }))} data-testid="input-edit-user-designation" />
        </div>
        <div>
          <Label>Role</Label>
          <Select value={form.role} onValueChange={(v) => setForm((f) => ({ ...f, role: v }))}>
            <SelectTrigger data-testid="select-edit-user-role"><SelectValue /></SelectTrigger>
            <SelectContent>{USER_ROLES.map((r) => <SelectItem key={r} value={r}>{roleLabel(r)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <Label>{propertyRequired ? "Property *" : "Property (optional)"}</Label>
          <Combobox
            options={propertyOptions}
            value={form.propertyId || null}
            onChange={(v) => setForm((f) => ({ ...f, propertyId: v || "" }))}
            placeholder={propertyRequired ? "Select a property" : "All properties"}
            searchPlaceholder="Search properties…"
            allowClear
          />
          {!propertyRequired && (
            <p className="text-xs text-muted-foreground mt-1">
              Org-wide / multi-scope roles don't need a single property here. Assign
              multi-property scope from Food &gt; Organization.
            </p>
          )}
        </div>
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label>Active</Label>
            <p className="text-xs text-muted-foreground">Deactivated users cannot sign in.</p>
          </div>
          <Select value={form.isActive ? "active" : "inactive"} onValueChange={(v) => setForm((f) => ({ ...f, isActive: v === "active" }))}>
            <SelectTrigger className="w-32" data-testid="select-edit-user-active"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </FormModal>
  );
}

export default function Users() {
  const { can } = usePermissions();
  const canCreate = can("USERS", "create");
  const canEdit = can("USERS", "edit");
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [bulkUploadOpen, setBulkUploadOpen] = React.useState(false);
  const [editUser, setEditUser] = React.useState<any | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const updateMut = useUpdateUser();
  const { data: usersRes, isLoading } = useGetUsers(undefined, { query: { queryKey: getGetUsersQueryKey() } });

  const users = usersRes?.data || [];

  const toggleActive = async (u: any) => {
    try {
      await updateMut.mutateAsync({ id: u.id, data: { isActive: !u.isActive } });
      toast({ title: u.isActive ? "User deactivated" : "User activated" });
      qc.invalidateQueries({ queryKey: getGetUsersQueryKey() });
    } catch (e: any) {
      toast({ title: e?.message || "Failed to update user", variant: "destructive" });
    }
  };

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
    },
    ...(canEdit ? [{
      id: "actions",
      header: "",
      cell: ({ row }: any) => (
        <div className="text-right">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" data-testid={`button-user-actions-${row.original.id}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditUser(row.original)}>Edit</DropdownMenuItem>
              <DropdownMenuItem
                className={row.original.isActive ? "text-destructive" : ""}
                onClick={() => toggleActive(row.original)}
              >
                {row.original.isActive ? "Deactivate" : "Activate"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )
    }] : [])
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users & Roles"
        subtitle="Manage administrative access and permissions"
        action={
          canCreate ? (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setBulkUploadOpen(true)} data-testid="button-bulk-upload-users">
                <Upload className="w-4 h-4 mr-2" />
                Bulk Upload
              </Button>
              <Button onClick={() => setInviteOpen(true)} data-testid="button-invite-user">
                <Plus className="w-4 h-4 mr-2" />
                Invite User
              </Button>
            </div>
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
      {canCreate && (
        <BulkUploadDialog
          resource="users"
          columns={USER_BULK_COLUMNS}
          open={bulkUploadOpen}
          onOpenChange={setBulkUploadOpen}
          onDone={() => qc.invalidateQueries({ queryKey: getGetUsersQueryKey() })}
        />
      )}
      {canEdit && (
        <EditUserModal
          user={editUser}
          open={!!editUser}
          onOpenChange={(o) => { if (!o) setEditUser(null); }}
        />
      )}
    </div>
  );
}
