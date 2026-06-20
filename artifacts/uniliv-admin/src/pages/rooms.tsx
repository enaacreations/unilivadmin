import * as React from "react"
import {
  useGetRooms,
  getGetRoomsQueryKey,
  useGetProperties,
  getGetPropertiesQueryKey,
  useCreateRoom,
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
import { NumberStepper } from "@/components/ui/number-stepper";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePermissions } from "@/lib/use-permissions";
import { useToast } from "@/hooks/use-toast";
import { Plus } from "lucide-react";

const ROOM_TYPES = ["SINGLE", "DOUBLE", "TRIPLE", "DORMITORY"];
const ROOM_STATUSES = ["VACANT", "OCCUPIED", "MAINTENANCE", "BLOCKED"];

function AddRoomModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const createMut = useCreateRoom();
  const { data: propsRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } });
  const properties = (propsRes as any)?.data || [];

  const empty = { propertyId: "", number: "", floor: 0, wing: "", type: "SINGLE", capacity: 1, status: "VACANT" };
  const [form, setForm] = React.useState(empty);
  React.useEffect(() => { if (open) setForm(empty); }, [open]);

  const propertyOptions = properties.map((p: any) => ({ value: p.id, label: p.name }));

  const onSave = async () => {
    if (!form.propertyId) { toast({ title: "Select a property", variant: "destructive" }); return; }
    if (!form.number.trim()) { toast({ title: "Room number is required", variant: "destructive" }); return; }
    try {
      await createMut.mutateAsync({
        data: { ...form, wing: form.wing || undefined },
      });
      toast({ title: "Room created" });
      qc.invalidateQueries({ queryKey: getGetRoomsQueryKey() });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed to create room", variant: "destructive" });
    }
  };

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title="Add Room"
      onSave={onSave}
      isSaving={createMut.isPending}
      saveLabel="Create Room"
    >
      <div className="space-y-4">
        <div>
          <Label>Property *</Label>
          <Combobox
            options={propertyOptions}
            value={form.propertyId || null}
            onChange={(v) => setForm((f) => ({ ...f, propertyId: v || "" }))}
            placeholder="Select property"
            searchPlaceholder="Search properties…"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Room Number *</Label>
            <Input value={form.number} onChange={(e) => setForm((f) => ({ ...f, number: e.target.value }))} data-testid="input-room-number" />
          </div>
          <div>
            <Label>Wing</Label>
            <Input value={form.wing} onChange={(e) => setForm((f) => ({ ...f, wing: e.target.value }))} />
          </div>
          <div>
            <Label>Floor</Label>
            <NumberStepper value={form.floor} onChange={(n) => setForm((f) => ({ ...f, floor: n }))} min={0} />
          </div>
          <div>
            <Label>Capacity</Label>
            <NumberStepper value={form.capacity} onChange={(n) => setForm((f) => ({ ...f, capacity: n }))} min={1} />
          </div>
          <div>
            <Label>Type</Label>
            <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v }))}>
              <SelectTrigger data-testid="select-room-type"><SelectValue /></SelectTrigger>
              <SelectContent>{ROOM_TYPES.map((t) => <SelectItem key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>Status</Label>
            <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
              <SelectTrigger data-testid="select-room-status"><SelectValue /></SelectTrigger>
              <SelectContent>{ROOM_STATUSES.map((s) => <SelectItem key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </FormModal>
  );
}

export default function Rooms() {
  const { can } = usePermissions();
  const canCreate = can("PROPERTIES", "create");
  const [addOpen, setAddOpen] = React.useState(false);
  const { data: roomsRes, isLoading } = useGetRooms(undefined, { query: { queryKey: getGetRoomsQueryKey() } });

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
          canCreate ? (
            <Button onClick={() => setAddOpen(true)} data-testid="button-add-room">
              <Plus className="w-4 h-4 mr-2" />
              Add Room
            </Button>
          ) : undefined
        }
      />

      <DataTable
        columns={columns}
        data={rooms}
        isLoading={isLoading}
        searchKey="number"
        searchPlaceholder="Search rooms..."
      />

      {canCreate && <AddRoomModal open={addOpen} onOpenChange={setAddOpen} />}
    </div>
  );
}
