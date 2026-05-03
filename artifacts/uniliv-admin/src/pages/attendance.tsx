import * as React from "react"
import { useGetAttendance, getGetAttendanceQueryKey } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";

export default function Attendance() {
  const { data: attendanceRes, isLoading } = useGetAttendance({ query: { queryKey: getGetAttendanceQueryKey() } });
  
  const records = attendanceRes?.data || [];

  const columns = [
    {
      accessorKey: "date",
      header: "Date",
      cell: ({ row }: any) => new Date(row.original.date).toLocaleDateString()
    },
    {
      accessorKey: "employeeName",
      header: "Employee",
      cell: ({ row }: any) => row.original.employeeName || 'Unknown'
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }: any) => <StatusBadge status={row.original.status} />
    },
    {
      accessorKey: "inTime",
      header: "In Time",
      cell: ({ row }: any) => row.original.inTime || '-'
    },
    {
      accessorKey: "outTime",
      header: "Out Time",
      cell: ({ row }: any) => row.original.outTime || '-'
    }
  ];

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Attendance" 
        subtitle="Track staff attendance and hours"
      />

      <DataTable 
        columns={columns}
        data={records}
        isLoading={isLoading}
      />
    </div>
  );
}
