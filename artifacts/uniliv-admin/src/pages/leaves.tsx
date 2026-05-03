import * as React from "react"
import { useGetLeaves, getGetLeavesQueryKey, useUpdateLeave } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Check, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";

export default function Leaves() {
  const queryClient = useQueryClient();
  const { data: leavesRes, isLoading } = useGetLeaves({ query: { queryKey: getGetLeavesQueryKey() } });
  const updateLeave = useUpdateLeave();
  
  const leaves = leavesRes?.data || [];

  const handleAction = (id: string, status: string, e: React.MouseEvent) => {
    e.stopPropagation();
    updateLeave.mutate({ id, data: { status } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetLeavesQueryKey() });
      }
    });
  };

  const columns = [
    {
      accessorKey: "employeeName",
      header: "Employee",
      cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.employeeName || 'Unknown'}</span>
    },
    {
      accessorKey: "type",
      header: "Type",
      cell: ({ row }: any) => <Badge variant="outline">{row.original.type}</Badge>
    },
    {
      accessorKey: "duration",
      header: "Duration",
      cell: ({ row }: any) => (
        <div>
          <div className="text-sm font-medium">
            {new Date(row.original.fromDate).toLocaleDateString()} - {new Date(row.original.toDate).toLocaleDateString()}
          </div>
          <div className="text-xs text-muted-foreground">{row.original.days} day(s)</div>
        </div>
      )
    },
    {
      accessorKey: "reason",
      header: "Reason",
      cell: ({ row }: any) => <span className="max-w-[200px] truncate block" title={row.original.reason}>{row.original.reason}</span>
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }: any) => <StatusBadge status={row.original.status} />
    },
    {
      id: "actions",
      cell: ({ row }: any) => {
        if (row.original.status === 'PENDING') {
          return (
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" className="text-success border-success/20 hover:bg-success/10" onClick={(e) => handleAction(row.original.id, 'APPROVED', e)} disabled={updateLeave.isPending}>
                <Check className="w-4 h-4" />
              </Button>
              <Button size="sm" variant="outline" className="text-destructive border-destructive/20 hover:bg-destructive/10" onClick={(e) => handleAction(row.original.id, 'REJECTED', e)} disabled={updateLeave.isPending}>
                <X className="w-4 h-4" />
              </Button>
            </div>
          );
        }
        return null;
      }
    }
  ];

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Leaves" 
        subtitle="Manage employee leave requests"
      />

      <DataTable 
        columns={columns}
        data={leaves}
        isLoading={isLoading}
      />
    </div>
  );
}
