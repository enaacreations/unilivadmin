import * as React from "react"
import { useGetEmployees, getGetEmployeesQueryKey } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";

export default function Employees() {
  const [, setLocation] = useLocation();
  const { data: employeesRes, isLoading } = useGetEmployees({ query: { queryKey: getGetEmployeesQueryKey() } });
  
  const employees = employeesRes?.data || [];

  const columns = [
    {
      accessorKey: "employeeCode",
      header: "Code",
      cell: ({ row }: any) => <span className="font-mono text-sm bg-muted/20 px-2 py-1 rounded">{row.original.employeeCode}</span>
    },
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }: any) => (
        <div className="font-medium text-primary hover:text-accent transition-colors">
          {row.original.name}
        </div>
      )
    },
    {
      accessorKey: "department",
      header: "Department",
      cell: ({ row }: any) => <Badge variant="secondary" className="text-xs uppercase tracking-wider">{row.original.department}</Badge>
    },
    {
      accessorKey: "designation",
      header: "Designation",
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }: any) => <StatusBadge status={row.original.status} />
    }
  ];

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Employees" 
        subtitle="Manage staff across all properties"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Add Employee
          </Button>
        }
      />

      <DataTable 
        columns={columns}
        data={employees}
        isLoading={isLoading}
        searchKey="name"
        searchPlaceholder="Search employees..."
        onRowClick={(row) => setLocation(`/employees/${row.id}`)}
      />
    </div>
  );
}
