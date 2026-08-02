import * as React from "react";
import {
  useGetProperty,
  getGetPropertyQueryKey,
  useGetRooms,
  getGetRoomsQueryKey,
  useGetResidents,
  getGetResidentsQueryKey,
  useGetComplaints,
  getGetComplaintsQueryKey,
  useCreateRoom,
  useUpdateRoom,
  useGetBookings,
  getGetBookingsQueryKey,
  useGetBookingAvailability,
  getGetBookingAvailabilityQueryKey,
  useDeleteBooking,
  type RoomDto,
  type BookingDto,
  type PropertyDto,
} from "@workspace/api-client-react";
import { useParams, useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormModal } from "@/components/ui/form-modal";
import { EmptyState } from "@/components/ui/empty-state";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import { DataTable } from "@/components/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  MapPin,
  Bed,
  Users,
  AlertCircle,
  Plus,
  Pencil,
  Phone,
  Mail,
  UserCog,
  FileText,
  Tag,
  Calendar as CalendarIcon,
  Trash2,
  Image as ImageIcon,
} from "lucide-react";
import { BookingFormModal } from "@/components/booking-form-modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PropertyImageCarousel } from "@/components/property-image-carousel";
import { PropertyPhotosManager } from "@/components/property-photos-manager";
import { ImageLightbox } from "@/components/image-lightbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  PORTFOLIO_TYPE_LABELS,
  ATTR_LABELS,
  portfolioAttrFields,
  type PortfolioType,
  type PortfolioAttributes,
} from "@/lib/portfolio-types";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";
import { formatDistanceToNow } from "date-fns";
import { Wifi, WifiOff, Zap as ZapIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/lib/use-permissions";
import { foodApi, foodKeys } from "@/lib/food-api";
import { UtensilsCrossed, ChefHat } from "lucide-react";

function bookingColumns({
  onEdit,
  onDelete,
  canEdit,
  canDelete,
}: {
  onEdit: (b: BookingDto) => void;
  onDelete: (b: BookingDto) => void;
  canEdit: boolean;
  canDelete: boolean;
}): ColumnDef<BookingDto, unknown>[] {
  // Bookings mutate through the RESIDENTS module, so viewers without those
  // rights (e.g. AUDIT_READONLY) get no actions column instead of buttons
  // whose requests would 403.
  const actionsCol: ColumnDef<BookingDto, unknown>[] = canEdit || canDelete ? [
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex gap-1 justify-end">
          {canEdit && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(row.original);
              }}
              data-testid={`button-edit-booking-${row.original.id}`}
            >
              <Pencil className="w-3.5 h-3.5" />
            </Button>
          )}
          {canDelete && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(row.original);
              }}
              data-testid={`button-delete-booking-${row.original.id}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ] : [];
  return [
    {
      accessorKey: "bookingNo",
      header: "Booking",
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.bookingNo}</span>
      ),
    },
    { accessorKey: "guestName", header: "Guest" },
    {
      accessorKey: "checkInDate",
      header: "Check-in",
      cell: ({ row }) =>
        new Date(row.original.checkInDate).toLocaleDateString(),
    },
    {
      accessorKey: "checkOutDate",
      header: "Check-out",
      cell: ({ row }) =>
        new Date(row.original.checkOutDate).toLocaleDateString(),
    },
    {
      accessorKey: "nights",
      header: "Nights",
      cell: ({ row }) => row.original.nights,
    },
    {
      accessorKey: "totalAmount",
      header: "Total",
      cell: ({ row }) => `₹${Number(row.original.totalAmount).toFixed(0)}`,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    ...actionsCol,
  ];
}

const roomSchema = z.object({
  number: z.string().min(1),
  floor: z.coerce.number().min(0),
  wing: z.string().optional(),
  type: z.enum(["SINGLE", "DOUBLE", "TRIPLE", "DORMITORY"]),
  capacity: z.coerce.number().min(1),
  status: z.enum(["VACANT", "OCCUPIED", "MAINTENANCE", "BLOCKED"]),
});
type RoomForm = z.infer<typeof roomSchema>;

function RoomFormModal({
  open,
  onOpenChange,
  propertyId,
  room,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  propertyId: string;
  room?: RoomDto | null;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const isEdit = !!room;
  const createMut = useCreateRoom();
  const updateMut = useUpdateRoom();
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<RoomForm>({
    resolver: zodResolver(roomSchema),
    defaultValues: {
      number: "",
      floor: 0,
      wing: "",
      type: "SINGLE",
      capacity: 1,
      status: "VACANT",
    },
  });

  React.useEffect(() => {
    if (open) {
      if (room) {
        reset({
          number: room.number,
          floor: room.floor,
          wing: room.wing || "",
          type: (room.type as any) || "SINGLE",
          capacity: room.capacity,
          status: (room.status as any) || "VACANT",
        });
      } else {
        reset({
          number: "",
          floor: 0,
          wing: "",
          type: "SINGLE",
          capacity: 1,
          status: "VACANT",
        });
      }
    }
  }, [open, room, reset]);

  const onSubmit = async (values: RoomForm) => {
    try {
      const body: any = { ...values, propertyId, wing: values.wing || undefined };
      if (isEdit && room) {
        await updateMut.mutateAsync({ id: room.id, data: body });
        toast({ title: "Room updated" });
      } else {
        await createMut.mutateAsync({ data: body });
        toast({ title: "Room created" });
      }
      qc.invalidateQueries({ queryKey: getGetRoomsQueryKey({ propertyId }) });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  };

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "Edit Room" : "Add Room"}
      onSave={handleSubmit(onSubmit)}
      isSaving={createMut.isPending || updateMut.isPending}
      saveLabel={isEdit ? "Save Changes" : "Create Room"}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Room Number *</Label>
            <Input data-testid="input-room-number" {...register("number")} />
            {errors.number && <p className="text-xs text-destructive">{errors.number.message}</p>}
          </div>
          <div>
            <Label>Floor *</Label>
            <Input type="number" data-testid="input-room-floor" {...register("floor")} />
            {errors.floor && <p className="text-xs text-destructive">{errors.floor.message}</p>}
          </div>
          <div>
            <Label>Wing</Label>
            <Input data-testid="input-room-wing" {...register("wing")} />
          </div>
          <div>
            <Label>Type *</Label>
            <Select value={watch("type")} onValueChange={(v) => setValue("type", v as any)}>
              <SelectTrigger data-testid="select-room-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SINGLE">Single</SelectItem>
                <SelectItem value="DOUBLE">Double</SelectItem>
                <SelectItem value="TRIPLE">Triple</SelectItem>
                <SelectItem value="DORMITORY">Dormitory</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Capacity *</Label>
            <Input type="number" min={1} data-testid="input-room-capacity" {...register("capacity")} />
            {errors.capacity && <p className="text-xs text-destructive">{errors.capacity.message}</p>}
          </div>
          <div>
            <Label>Status</Label>
            <Select value={watch("status")} onValueChange={(v) => setValue("status", v as any)}>
              <SelectTrigger data-testid="select-room-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="VACANT">Vacant</SelectItem>
                <SelectItem value="OCCUPIED">Occupied</SelectItem>
                <SelectItem value="MAINTENANCE">Maintenance</SelectItem>
                <SelectItem value="BLOCKED">Blocked</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </FormModal>
  );
}

function RoomIoTBadge({ propertyId, roomId }: { propertyId: string; roomId: string }) {
  const { can } = usePermissions();
  if (!can("IOT", "view")) return null;
  return <RoomIoTBadgeInner propertyId={propertyId} roomId={roomId} />;
}

function RoomIoTBadgeInner({ propertyId, roomId }: { propertyId: string; roomId: string }) {
  const { data } = useQuery<{ data: Array<{ deviceId: string; name: string; deviceType: string; status: string; roomId?: string | null; lastSeenAt: string | null; latest: { metric: string; value: number | null; recordedAt: string } | null }> }>({
    queryKey: ["property-iot-latest", propertyId],
    queryFn: () => apiFetch(`/iot/latest?propertyId=${propertyId}`),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const all = data?.data || [];
  const forRoom = all.filter((d) => d.roomId === roomId);
  if (forRoom.length === 0) return null;
  return (
    <div className="border-t pt-2 mt-1 space-y-1" data-testid={`room-iot-${roomId}`}>
      {forRoom.slice(0, 3).map((d) => {
        const seenMs = d.lastSeenAt ? Date.now() - new Date(d.lastSeenAt).getTime() : null;
        const online = d.status === "ACTIVE" && seenMs != null && seenMs < 600_000;
        return (
          <div key={d.deviceId} className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1">
              {online ? <Wifi className="w-3 h-3 text-success" /> : <WifiOff className="w-3 h-3 text-muted-foreground" />}
              <span className="truncate max-w-[100px]">{d.name}</span>
            </div>
            <span className="font-mono">{d.latest?.value ?? "—"}</span>
          </div>
        );
      })}
      {forRoom.length > 3 && <div className="text-[10px] text-muted-foreground">+{forRoom.length - 3} more</div>}
    </div>
  );
}

function PropertyIoTTab({ propertyId }: { propertyId: string }) {
  const { data, isLoading } = useQuery<{ data: Array<{ deviceId: string; name: string; deviceType: string; status: string; lastSeenAt: string | null; latest: { metric: string; value: number | null; recordedAt: string } | null }> }>({
    queryKey: ["property-iot-latest", propertyId],
    queryFn: () => apiFetch(`/iot/latest?propertyId=${propertyId}`),
    refetchInterval: 30_000,
  });
  const latest = data?.data || [];
  if (isLoading) return <Skeleton className="h-32" />;
  if (latest.length === 0) return <EmptyState icon={Wifi} title="No IoT devices" description="Register devices from the IoT page" />;
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {latest.map((l) => {
        const seenMs = l.lastSeenAt ? Date.now() - new Date(l.lastSeenAt).getTime() : null;
        const online = l.status === "ACTIVE" && seenMs != null && seenMs < 600_000;
        return (
          <Card key={l.deviceId} data-testid={`property-live-${l.deviceId}`}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="font-medium">{l.name}</div>
                {online ? <Badge><Wifi className="w-3 h-3 mr-1" />Online</Badge> : <Badge variant="secondary"><WifiOff className="w-3 h-3 mr-1" />Stale</Badge>}
              </div>
              <div className="text-xs text-muted-foreground">{l.deviceType}</div>
              {l.latest ? (
                <div className="pt-2 border-t">
                  <div className="text-xs text-muted-foreground">{l.latest.metric}</div>
                  <div className="text-2xl font-display font-bold">{l.latest.value ?? "—"}</div>
                  <div className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(l.latest.recordedAt), { addSuffix: true })}</div>
                </div>
              ) : <div className="text-xs text-muted-foreground pt-2">No readings yet.</div>}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function PropertyElectricityTab({ propertyId }: { propertyId: string }) {
  const { data: metersRes } = useQuery<{ data: any[] }>({ queryKey: ["property-meters", propertyId], queryFn: () => apiFetch(`/electricity/meters?propertyId=${propertyId}`) });
  const { data: readingsRes } = useQuery<{ data: any[] }>({ queryKey: ["property-readings", propertyId], queryFn: () => apiFetch(`/electricity/readings?propertyId=${propertyId}`) });
  const meters = metersRes?.data || [];
  const readings = readingsRes?.data || [];
  const totalUnits = readings.reduce((s, r) => s + (Number(r.unitsConsumed) || 0), 0);
  const postedAmount = readings.filter((r) => r.posted).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Active meters</div><div className="text-2xl font-display font-bold">{meters.filter((m: any) => m.isActive).length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Units consumed</div><div className="text-2xl font-display font-bold">{totalUnits.toFixed(1)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Posted amount</div><div className="text-2xl font-display font-bold">₹{postedAmount.toFixed(0)}</div></CardContent></Card>
      </div>
      {meters.length === 0 ? <EmptyState icon={ZapIcon} title="No meters" description="Add meters from the Electricity page" /> : (
        <Card><CardContent className="p-0">
          <BoundedScroll size="md">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card"><TableRow><TableHead>Meter No.</TableHead><TableHead>Label</TableHead><TableHead>Room</TableHead><TableHead>Resident</TableHead><TableHead>Tariff</TableHead></TableRow></TableHeader>
              <TableBody>
                {meters.map((m: any) => (
                  <TableRow key={m.id}><TableCell className="font-mono">{m.meterNo}</TableCell><TableCell>{m.label || "—"}</TableCell><TableCell>{m.roomNumber || "—"}</TableCell><TableCell>{m.residentName || "—"}</TableCell><TableCell className="text-xs">{m.tariffName || "—"}</TableCell></TableRow>
                ))}
              </TableBody>
            </Table>
          </BoundedScroll>
        </CardContent></Card>
      )}
    </div>
  );
}

// Photo gallery shown near the top of the property detail page. Displays a
// carousel; editors can toggle into inline photo management (upload/delete/
// set-primary). Photos come back ordered ascending by sortOrder (hero flagged
// via isHero); we sort hero-first for the carousel.
function PropertyPhotoGallery({ propertyId, canEdit }: { propertyId: string; canEdit: boolean }) {
  const { data: photos = [], isLoading } = useQuery({
    queryKey: foodKeys.propertyPhotos(propertyId),
    queryFn: () => foodApi.listPropertyPhotos(propertyId),
  });
  const [manageOpen, setManageOpen] = React.useState(false);
  const [lightboxIndex, setLightboxIndex] = React.useState<number | null>(null);
  const urls = React.useMemo(
    () =>
      [...photos]
        .sort((a, b) => {
          if (a.isHero !== b.isHero) return a.isHero ? -1 : 1;
          return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
        })
        .map((p) => p.url)
        .filter(Boolean) as string[],
    [photos],
  );

  // Non-editors with no photos: render nothing (as before). Editors always
  // get the card so they can open the manager and upload the first photo.
  if (!canEdit && (isLoading || photos.length === 0)) return null;

  return (
    <>
      <Card data-testid="property-photo-gallery">
        <CardContent className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-display font-semibold text-primary flex items-center gap-2">
              <ImageIcon className="w-4 h-4" /> Photos
            </h3>
            {canEdit && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setManageOpen(true)}
                data-testid="property-photos-manage-toggle"
              >
                <Pencil className="w-4 h-4 mr-1" /> Manage Photos
              </Button>
            )}
          </div>
          <PropertyImageCarousel
            images={urls}
            aspectClassName="h-72 sm:h-80"
            fit="contain"
            onImageClick={urls.length ? (i) => setLightboxIndex(i) : undefined}
          />
        </CardContent>
      </Card>

      <ImageLightbox
        images={urls}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
      />

      {canEdit && (
        <Dialog open={manageOpen} onOpenChange={setManageOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Manage Photos</DialogTitle>
              <DialogDescription>
                Upload new images, set the primary photo, or remove existing ones.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[70vh] overflow-y-auto pr-1">
              <PropertyPhotosManager propertyId={propertyId} />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

export default function PropertyDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id as string;
  const [, setLocation] = useLocation();

  const { data: propertyRes, isLoading: propertyLoading } = useGetProperty(id, {
    query: { queryKey: getGetPropertyQueryKey(id), enabled: !!id },
  });
  const { data: roomsRes, isLoading: roomsLoading } = useGetRooms(
    { propertyId: id },
    { query: { queryKey: getGetRoomsQueryKey({ propertyId: id }), enabled: !!id } }
  );
  const { data: residentsRes } = useGetResidents(
    { propertyId: id },
    { query: { queryKey: getGetResidentsQueryKey({ propertyId: id }), enabled: !!id } }
  );
  const { data: complaintsRes } = useGetComplaints(
    { propertyId: id },
    { query: { queryKey: getGetComplaintsQueryKey({ propertyId: id }), enabled: !!id } }
  );

  const { data: kitchens = [] } = useQuery({
    queryKey: foodKeys.kitchens({ active: true }),
    queryFn: () => foodApi.listKitchens({ active: true }),
  });

  const property = propertyRes?.data;
  const propertyKitchenName = property?.kitchenId
    ? kitchens.find((k) => k.id === property.kitchenId)?.name ?? null
    : null;
  const rooms = roomsRes?.data || [];
  const residents = residentsRes?.data || [];
  const complaints = complaintsRes?.data || [];

  const [roomFilterStatus, setRoomFilterStatus] = React.useState("ALL");
  const [roomFilterType, setRoomFilterType] = React.useState("ALL");
  const [roomModalOpen, setRoomModalOpen] = React.useState(false);
  const [editingRoom, setEditingRoom] = React.useState<RoomDto | null>(null);

  const [bookingModalOpen, setBookingModalOpen] = React.useState(false);
  const [editingBooking, setEditingBooking] = React.useState<BookingDto | null>(null);
  const [bookingToDelete, setBookingToDelete] = React.useState<BookingDto | null>(null);
  const today0 = React.useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const [calStart, setCalStart] = React.useState<Date>(today0);
  const calEnd = React.useMemo(() => {
    const d = new Date(calStart);
    d.setDate(d.getDate() + 14);
    return d;
  }, [calStart]);
  const isShortStay = property?.portfolioType === "SERVICED_APARTMENTS";
  const { can } = usePermissions();
  const showIot = can("IOT", "view");
  const showElec = can("ELECTRICITY", "view");

  const { data: bookingsRes, isLoading: bookingsLoading } = useGetBookings(
    { propertyId: id },
    {
      query: {
        queryKey: getGetBookingsQueryKey({ propertyId: id }),
        enabled: !!id && !!isShortStay,
      },
    },
  );
  const bookings = bookingsRes?.data || [];

  const availParams = {
    propertyId: id,
    from: calStart.toISOString(),
    to: calEnd.toISOString(),
  };
  const { data: availRes } = useGetBookingAvailability(availParams, {
    query: {
      queryKey: getGetBookingAvailabilityQueryKey(availParams),
      enabled: !!id && !!isShortStay,
    },
  });
  const availability = availRes?.data || [];

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const deleteBookingMut = useDeleteBooking({
    mutation: {
      onSuccess: () => {
        toast({ title: "Booking cancelled" });
        queryClient.invalidateQueries({
          queryKey: getGetBookingsQueryKey({ propertyId: id }),
        });
        queryClient.invalidateQueries({ queryKey: ["bookings"], exact: false });
        setBookingToDelete(null);
      },
      onError: (e: any) =>
        toast({ title: e?.message || "Failed", variant: "destructive" }),
    },
  });

  const filteredRooms = rooms.filter(
    (r) =>
      (roomFilterStatus === "ALL" || r.status === roomFilterStatus) &&
      (roomFilterType === "ALL" || r.type === roomFilterType)
  );

  if (propertyLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!property) return <div>Property not found</div>;

  const occupied = property.occupiedBeds || 0;
  const vacant = (property.totalBeds || 0) - occupied;

  return (
    <div className="space-y-6">

      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-primary">
            {property.name}
          </h1>
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="outline" className="flex items-center gap-1" data-testid="badge-property-portfolio-type">
              <Tag className="w-3 h-3" />
              {PORTFOLIO_TYPE_LABELS[(property.portfolioType as PortfolioType) || "CO_LIVING"]}
            </Badge>
          </div>
          <p className="text-muted-foreground flex items-center gap-1 mt-1 text-sm">
            <MapPin className="w-4 h-4" /> {property.address}, {property.city},{" "}
            {property.state} {property.pincode}
          </p>
        </div>
        <StatusBadge status={property.status} className="px-3 py-1" />
      </div>

      <PropertyPhotoGallery propertyId={id} canEdit={can("PROPERTIES", "edit")} />

      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-full"><Bed className="w-5 h-5 text-primary" /></div>
            <div>
              <p className="text-xs text-muted-foreground uppercase">Total Beds</p>
              <p className="text-2xl font-display font-bold text-primary">{property.totalBeds}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 bg-success/10 rounded-full"><Users className="w-5 h-5 text-success" /></div>
            <div>
              <p className="text-xs text-muted-foreground uppercase">Occupied</p>
              <p className="text-2xl font-display font-bold text-primary">{occupied}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 bg-warning/10 rounded-full"><Bed className="w-5 h-5 text-warning" /></div>
            <div>
              <p className="text-xs text-muted-foreground uppercase">Vacant</p>
              <p className="text-2xl font-display font-bold text-primary">{vacant}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 bg-destructive/10 rounded-full"><AlertCircle className="w-5 h-5 text-destructive" /></div>
            <div>
              <p className="text-xs text-muted-foreground uppercase">Complaints</p>
              <p className="text-2xl font-display font-bold text-primary">{complaints.length}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="bg-surface">
          <TabsTrigger value="overview" data-testid="tab-overview">Overview</TabsTrigger>
          <TabsTrigger value="rooms" data-testid="tab-rooms">Rooms</TabsTrigger>
          <TabsTrigger value="residents" data-testid="tab-residents">Residents</TabsTrigger>
          <TabsTrigger value="complaints" data-testid="tab-complaints">Complaints</TabsTrigger>
          <TabsTrigger value="documents" data-testid="tab-documents">Documents</TabsTrigger>
          {isShortStay && <TabsTrigger value="bookings" data-testid="tab-bookings">Bookings</TabsTrigger>}
          {showIot && <TabsTrigger value="iot" data-testid="tab-property-iot">IoT</TabsTrigger>}
          {showElec && <TabsTrigger value="electricity" data-testid="tab-property-electricity">Electricity</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardContent className="p-4">
                <h3 className="font-display font-semibold text-primary mb-3">Location</h3>
                {property.lat && property.lng ? (
                  <iframe
                    title="map"
                    src={`https://www.openstreetmap.org/export/embed.html?bbox=${property.lng - 0.005}%2C${property.lat - 0.005}%2C${property.lng + 0.005}%2C${property.lat + 0.005}&layer=mapnik&marker=${property.lat}%2C${property.lng}`}
                    className="w-full h-64 rounded-lg border"
                  />
                ) : (
                  <div className="w-full h-64 rounded-lg border border-dashed bg-surface flex items-center justify-center text-sm text-muted-foreground">
                    Location coordinates not set
                  </div>
                )}
              </CardContent>
            </Card>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 content-start">
              {(() => {
                const t = (property.portfolioType as PortfolioType) || "CO_LIVING";
                const fields = portfolioAttrFields(t);
                const attrs = (property.portfolioAttributes as PortfolioAttributes) || {};
                if (fields.length === 0) return null;
                return (
                  <Card className="sm:col-span-2" data-testid="card-portfolio-attributes">
                    <CardContent className="p-4">
                      <h3 className="font-display font-semibold text-primary mb-3">
                        {PORTFOLIO_TYPE_LABELS[t]} Details
                      </h3>
                      <dl className="grid grid-cols-2 gap-y-2 gap-x-3 text-sm">
                        {fields.map((f) => {
                          const v: PortfolioAttributes[typeof f] = attrs[f];
                          let display: React.ReactNode = "—";
                          if (v !== undefined && v !== null && v !== "") {
                            if (typeof v === "boolean") display = v ? "Yes" : "No";
                            else display = String(v);
                          }
                          return (
                            <React.Fragment key={f}>
                              <dt className="text-muted-foreground text-xs uppercase tracking-wide">
                                {ATTR_LABELS[f]}
                              </dt>
                              <dd className="text-primary font-medium">{display}</dd>
                            </React.Fragment>
                          );
                        })}
                      </dl>
                    </CardContent>
                  </Card>
                );
              })()}
              <Card>
                <CardContent className="p-4">
                  <h3 className="font-display font-semibold text-primary mb-3">Amenities</h3>
                  {property.amenities && property.amenities.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {property.amenities.map((a) => (
                        <Badge key={a} variant="secondary">{a}</Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No amenities listed</p>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <h3 className="font-display font-semibold text-primary mb-3">Contact</h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2"><Phone className="w-4 h-4 text-muted-foreground" /> {property.phone || "—"}</div>
                    <div className="flex items-center gap-2"><Mail className="w-4 h-4 text-muted-foreground" /> {property.email || "—"}</div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <h3 className="font-display font-semibold text-primary mb-3 flex items-center gap-2"><UserCog className="w-4 h-4" /> Warden</h3>
                  <p className="text-sm text-muted-foreground">{property.wardenId ? `Warden ID: ${property.wardenId}` : "No warden assigned"}</p>
                </CardContent>
              </Card>
              <Card className="sm:col-span-2" data-testid="card-food-config">
                <CardContent className="p-4">
                  <h3 className="font-display font-semibold text-primary mb-3 flex items-center gap-2"><UtensilsCrossed className="w-4 h-4" /> Food Configuration</h3>
                  <dl className="grid grid-cols-2 gap-y-2 gap-x-3 text-sm">
                    <dt className="text-muted-foreground text-xs uppercase tracking-wide flex items-center gap-1"><Tag className="w-3 h-3" /> Brand</dt>
                    <dd className="text-primary font-medium" data-testid="text-property-brand">
                      {property.brand ? <Badge variant="secondary">{property.brand}</Badge> : <span className="text-muted-foreground">Not assigned</span>}
                    </dd>
                    <dt className="text-muted-foreground text-xs uppercase tracking-wide flex items-center gap-1"><ChefHat className="w-3 h-3" /> Kitchen</dt>
                    <dd className="text-primary font-medium" data-testid="text-property-kitchen">
                      {propertyKitchenName ?? (property.kitchenId ? property.kitchenId : <span className="text-muted-foreground">Not assigned</span>)}
                    </dd>
                  </dl>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="rooms" className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex gap-2">
              <Select value={roomFilterStatus} onValueChange={setRoomFilterStatus}>
                <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All Status</SelectItem>
                  <SelectItem value="VACANT">Vacant</SelectItem>
                  <SelectItem value="OCCUPIED">Occupied</SelectItem>
                  <SelectItem value="MAINTENANCE">Maintenance</SelectItem>
                  <SelectItem value="BLOCKED">Blocked</SelectItem>
                </SelectContent>
              </Select>
              <Select value={roomFilterType} onValueChange={setRoomFilterType}>
                <SelectTrigger className="w-40"><SelectValue placeholder="Type" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All Types</SelectItem>
                  <SelectItem value="SINGLE">Single</SelectItem>
                  <SelectItem value="DOUBLE">Double</SelectItem>
                  <SelectItem value="TRIPLE">Triple</SelectItem>
                  <SelectItem value="DORMITORY">Dormitory</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              className="bg-accent hover:bg-accent/90 text-white"
              onClick={() => { setEditingRoom(null); setRoomModalOpen(true); }}
              data-testid="button-add-room"
            >
              <Plus className="w-4 h-4 mr-2" /> Add Room
            </Button>
          </div>
          {roomsLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {[1,2,3,4].map(i => <Skeleton key={i} className="h-32 w-full" />)}
            </div>
          ) : filteredRooms.length === 0 ? (
            <EmptyState icon={Bed} title="No rooms" description="Add your first room to get started" />
          ) : (
            <BoundedScroll size="lg" className="pr-2">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {filteredRooms.map((room) => (
                <Card key={room.id} className="hover:border-accent/50 transition-colors group" data-testid={`row-room-${room.id}`}>
                  <CardContent className="p-4 flex flex-col gap-3">
                    <div className="flex justify-between items-start">
                      <span className="font-display font-bold text-2xl text-primary">{room.number}</span>
                      <Button size="icon" variant="ghost" className="h-7 w-7 opacity-0 group-hover:opacity-100" onClick={() => { setEditingRoom(room); setRoomModalOpen(true); }} data-testid={`button-edit-room-${room.id}`}>
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Floor {room.floor}{room.wing ? ` · Wing ${room.wing}` : ""}
                    </div>
                    <div className="text-sm flex justify-between items-center border-t pt-2">
                      <Badge variant="outline" className="text-xs">{room.type}</Badge>
                      <span className="text-primary font-medium">{room.occupancy}/{room.capacity}</span>
                    </div>
                    <StatusBadge status={room.status} />
                    <RoomIoTBadge propertyId={id} roomId={room.id} />
                  </CardContent>
                </Card>
              ))}
            </div>
            </BoundedScroll>
          )}
          <RoomFormModal
            open={roomModalOpen}
            onOpenChange={setRoomModalOpen}
            propertyId={id}
            room={editingRoom}
          />
        </TabsContent>

        <TabsContent value="residents" className="mt-6">
          <DataTable
            columns={[
              { accessorKey: "name", header: "Name" },
              { accessorKey: "roomNumber", header: "Room", cell: ({ row }: any) => row.original.roomNumber || "—" },
              { accessorKey: "phone", header: "Phone" },
              { accessorKey: "planType", header: "Plan", cell: ({ row }: any) => row.original.planType || "—" },
              { accessorKey: "status", header: "Status", cell: ({ row }: any) => <StatusBadge status={row.original.status} /> },
            ] as any}
            data={residents}
            onRowClick={(r: any) => setLocation(`/residents/${r.id}`)}
          />
        </TabsContent>

        <TabsContent value="complaints" className="mt-6">
          <DataTable
            columns={[
              { accessorKey: "ticketNo", header: "Ticket", cell: ({ row }: any) => <span className="font-mono text-xs">{row.original.ticketNo}</span> },
              { accessorKey: "title", header: "Title" },
              { accessorKey: "category", header: "Category" },
              { accessorKey: "priority", header: "Priority", cell: ({ row }: any) => <StatusBadge status={row.original.priority} /> },
              { accessorKey: "status", header: "Status", cell: ({ row }: any) => <StatusBadge status={row.original.status} /> },
              { accessorKey: "createdAt", header: "Date", cell: ({ row }: any) => new Date(row.original.createdAt).toLocaleDateString() },
            ] as any}
            data={complaints}
          />
        </TabsContent>

        <TabsContent value="iot" className="mt-6">
          <PropertyIoTTab propertyId={id} />
        </TabsContent>
        <TabsContent value="electricity" className="mt-6">
          <PropertyElectricityTab propertyId={id} />
        </TabsContent>

        <TabsContent value="documents" className="mt-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {["Property License", "Lease Agreement", "Tax Records", "Insurance"].map((label) => (
              <Card key={label}>
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <FileText className="w-5 h-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-primary">{label}</p>
                      <p className="text-xs text-muted-foreground">Not uploaded</p>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" disabled>Upload</Button>
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="mt-6">
            <EmptyState
              icon={FileText}
              title="Document storage pending"
              description="Documents will be stored once object storage is configured"
            />
          </div>
        </TabsContent>

        {isShortStay && (
          <TabsContent value="bookings" className="mt-6 space-y-6">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="font-display font-semibold text-primary text-lg">Bookings</h3>
                <p className="text-xs text-muted-foreground">Short-stay reservations for this property</p>
              </div>
              <Button
                className="bg-accent hover:bg-accent/90 text-white"
                onClick={() => { setEditingBooking(null); setBookingModalOpen(true); }}
                data-testid="button-add-booking"
              >
                <Plus className="w-4 h-4 mr-2" /> New Booking
              </Button>
            </div>

            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-display font-semibold text-primary text-sm flex items-center gap-2">
                    <CalendarIcon className="w-4 h-4" /> Availability (next 14 days)
                  </h4>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const d = new Date(calStart);
                        d.setDate(d.getDate() - 14);
                        setCalStart(d);
                      }}
                      data-testid="button-cal-prev"
                    >
                      ← Prev
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setCalStart(today0)}
                    >
                      Today
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const d = new Date(calStart);
                        d.setDate(d.getDate() + 14);
                        setCalStart(d);
                      }}
                      data-testid="button-cal-next"
                    >
                      Next →
                    </Button>
                  </div>
                </div>
                {availability.length === 0 ? (
                  <EmptyState
                    icon={Bed}
                    title="No rooms"
                    description="Add rooms to see availability"
                  />
                ) : (
                  <BoundedScroll size="md" data-testid="availability-grid">
                    <table className="text-xs border-collapse">
                      <thead className="sticky top-0 z-20 bg-card">
                        <tr>
                          <th className="sticky left-0 z-10 bg-card text-left px-2 py-1 border-b font-medium">Room</th>
                          {Array.from({ length: 14 }).map((_, i) => {
                            const d = new Date(calStart);
                            d.setDate(d.getDate() + i);
                            return (
                              <th key={i} className="px-1 py-1 border-b text-muted-foreground font-normal min-w-[34px]">
                                <div>{d.getDate()}</div>
                                <div className="text-[10px]">
                                  {d.toLocaleDateString(undefined, { month: "short" })}
                                </div>
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {availability.map((row) => {
                          const occSet = new Set<string>();
                          for (const b of row.bookings || []) {
                            const ci = new Date(b.checkInDate);
                            const co = new Date(b.checkOutDate);
                            for (let t = ci.getTime(); t < co.getTime(); t += 86400000) {
                              occSet.add(new Date(t).toISOString().slice(0, 10));
                            }
                          }
                          return (
                            <tr key={row.roomId} data-testid={`avail-row-${row.roomId}`}>
                              <td className="sticky left-0 bg-card px-2 py-1 border-b font-mono">
                                {row.number}
                              </td>
                              {Array.from({ length: 14 }).map((_, i) => {
                                const d = new Date(calStart);
                                d.setDate(d.getDate() + i);
                                const key = d.toISOString().slice(0, 10);
                                const occ = occSet.has(key);
                                return (
                                  <td
                                    key={i}
                                    className={`border-b border-l text-center ${occ ? "bg-destructive/30" : "bg-success/15"}`}
                                    title={`${row.number} · ${key} · ${occ ? "Booked" : "Available"}`}
                                  >
                                    <div className="w-full h-6" />
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </BoundedScroll>
                )}
                {availability.length > 0 && (
                  <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-3 bg-success/15 border" /> Available
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-3 bg-destructive/30 border" /> Booked
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {bookingsLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : bookings.length === 0 ? (
              <EmptyState
                icon={CalendarIcon}
                title="No bookings yet"
                description="Create the first booking for this property"
              />
            ) : (
              <Card>
                <CardContent className="p-0">
                  <DataTable
                    columns={bookingColumns({
                      onEdit: (b) => {
                        setEditingBooking(b);
                        setBookingModalOpen(true);
                      },
                      onDelete: (b) => setBookingToDelete(b),
                      canEdit: can("RESIDENTS", "edit"),
                      canDelete: can("RESIDENTS", "delete"),
                    })}
                    data={bookings}
                  />
                </CardContent>
              </Card>
            )}
          </TabsContent>
        )}
      </Tabs>

      {isShortStay && property && (
        <BookingFormModal
          open={bookingModalOpen}
          onOpenChange={(o) => {
            setBookingModalOpen(o);
            if (!o) setEditingBooking(null);
          }}
          property={property as PropertyDto}
          booking={editingBooking}
        />
      )}
      <ConfirmDialog
        open={!!bookingToDelete}
        onOpenChange={(o) => { if (!o) setBookingToDelete(null); }}
        title="Cancel booking?"
        description={
          bookingToDelete
            ? `Booking ${bookingToDelete.bookingNo} for ${bookingToDelete.guestName} will be marked as cancelled.`
            : ""
        }
        confirmLabel="Cancel booking"
        isConfirming={deleteBookingMut.isPending}
        onConfirm={() => {
          if (bookingToDelete) {
            deleteBookingMut.mutate({ id: bookingToDelete.id });
          }
        }}
      />
    </div>
  );
}
