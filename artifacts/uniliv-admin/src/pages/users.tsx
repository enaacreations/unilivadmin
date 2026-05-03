import * as React from "react"
import { useGetUsers, getGetUsersQueryKey } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";

export default function Users() {
  const { data: usersRes, isLoading } = useGetUsers({ query: { queryKey: getGetUsersQueryKey() } });
  
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
          <Button className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Invite User
          </Button>
        }
      />

      <DataTable 
        columns={columns}
        data={users}
        isLoading={isLoading}
        searchKey="name"
        searchPlaceholder="Search users..."
      />
    </div>
  );
}
