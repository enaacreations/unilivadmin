import * as React from "react"
import { useGetRooms, getGetRoomsQueryKey } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export default function Rooms() {
  const { data: roomsRes, isLoading } = useGetRooms({ query: { queryKey: getGetRoomsQueryKey() } });
  
  const rooms = roomsRes?.data || [];

  const columns = [
    {
      accessorKey: "number",
      header: "Room Number",
    },
    {
      accessorKey: "floor",
      header: "Floor & Wing",
      cell: ({ row }: any) => `${row.original.floor}${row.original.wing ? ` - Wing ${row.original.wing}` : ''}`
    },
    {
      accessorKey: "type",
      header: "Type",
    },
    {
      accessorKey: "capacity",
      header: "Occupancy",
      cell: ({ row }: any) => `${row.original.occupancy || 0} / ${row.original.capacity || 0}`
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
        title="Rooms" 
        subtitle="Manage room inventory across properties"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Add Room
          </Button>
        }
      />

      <DataTable 
        columns={columns}
        data={rooms}
        isLoading={isLoading}
        searchKey="number"
        searchPlaceholder="Search rooms..."
      />
    </div>
  );
}
