import * as React from "react";
import { useLocation, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Truck,
  MapPin,
  User,
  Clock,
  Phone,
  Building2,
  Package,
  CheckCircle2,
  XCircle,
  PackageX,
  CalendarDays,
  Users,
  Scale,
  Hash,
  AlertTriangle,
  ListChecks,
  Ban,
  Check,
  Pencil,
  Info,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NumberStepper } from "@/components/ui/number-stepper";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/lib/use-permissions";
import { OrderTimeline } from "@/components/order-timeline";
import { cn } from "@/lib/utils";
import {
  foodApi,
  foodKeys,
  MEAL_LABEL,
  fmtQty,
  type OrderStatus,
  type FoodOrderEvent,
} from "@/lib/food-api";

const fmtDate = (s?: string | null) =>
  s ? format(new Date(s), "dd MMM yyyy") : "—";
const fmtTime = (s?: string | null) => (s ? format(new Date(s), "HH:mm") : "—");
const fmtDateTime = (s?: string | null) =>
  s ? format(new Date(s), "dd MMM, HH:mm") : "—";


/** ACCEPTED → green Badge, REJECTED → destructive Badge, else StatusBadge. */
function OrderStatusBadge({ status }: { status: OrderStatus }) {
  if (status === "ACCEPTED")
    return <Badge variant="success">Accepted</Badge>;
  if (status === "REJECTED")
    return <Badge variant="destructive">Rejected</Badge>;
  return <StatusBadge status={status} />;
}

function InfoTile({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="w-3.5 h-3.5" />
        <span className="text-[11px] uppercase tracking-wider font-medium">
          {label}
        </span>
      </div>
      <div className="text-sm font-medium text-foreground">{children}</div>
    </div>
  );
}

function DispatchRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 h-9 w-9 shrink-0 rounded-md bg-muted/60 flex items-center justify-center">
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
          {label}
        </p>
        <div className="text-sm font-medium text-foreground mt-0.5">
          {children}
        </div>
      </div>
    </div>
  );
}

export default function FoodOrderDetail() {
  const params = useParams();
  const id = params.id as string;
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { can } = usePermissions();

  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [rejectReason, setRejectReason] = React.useState("");
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [cancelReason, setCancelReason] = React.useState("");
  const [editOpen, setEditOpen] = React.useState(false);
  // Edit form fields — pre-filled from the order when the dialog opens.
  // B3-6: the people count is the ONLY editable quantity input; item quantities
  // are recomputed server-side from it.
  const [editResidents, setEditResidents] = React.useState(1);
  const [editNotes, setEditNotes] = React.useState("");

  const {
    data: order,
    isLoading,
    isError,
  } = useQuery({
    queryKey: foodKeys.order(id),
    queryFn: () => foodApi.getOrder(id),
    enabled: !!id,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: foodKeys.order(id) });
    qc.invalidateQueries({ queryKey: ["food"] });
  };

  const acceptMut = useMutation({
    mutationFn: () => foodApi.acceptOrder(id),
    onSuccess: () => {
      invalidate();
      toast({ title: "Order accepted" });
    },
    onError: (e: any) =>
      toast({ title: e?.message || "Failed to accept", variant: "destructive" }),
  });

  const rejectMut = useMutation({
    mutationFn: () => foodApi.rejectOrder(id, rejectReason.trim() || undefined),
    onSuccess: () => {
      invalidate();
      toast({ title: "Order rejected" });
      setRejectOpen(false);
      setRejectReason("");
    },
    onError: (e: any) =>
      toast({ title: e?.message || "Failed to reject", variant: "destructive" }),
  });

  const cancelMut = useMutation({
    mutationFn: () => foodApi.cancelOrder(id, cancelReason.trim() || undefined),
    onSuccess: () => {
      invalidate();
      toast({ title: "Order cancelled" });
      setCancelOpen(false);
      setCancelReason("");
    },
    onError: (e: any) =>
      toast({ title: e?.message || "Failed to cancel", variant: "destructive" }),
  });

  // Pre-fill the edit form from the current order each time the dialog opens.
  const openEdit = () => {
    if (!order) return;
    setEditResidents(order.residentsCount > 0 ? order.residentsCount : 1);
    setEditNotes(order.notes ?? "");
    setEditOpen(true);
  };

  const editMut = useMutation({
    // B3-6: only the people count (and optionally notes) is sent; the server
    // recomputes all item quantities + totalQuantity from the people count.
    mutationFn: () =>
      foodApi.editOrderPeople(id, editResidents, editNotes.trim() || null),
    onSuccess: () => {
      invalidate();
      toast({ title: "Order updated" });
      setEditOpen(false);
    },
    onError: (e: any) =>
      toast({ title: e?.message || "Failed to update order", variant: "destructive" }),
  });

  // Delivery punctuality.
  const delivery = React.useMemo(() => {
    if (!order?.deliveredAt) return null;
    if (!order.expectedDeliveryAt) return { delayed: false };
    return {
      delayed:
        new Date(order.deliveredAt).getTime() >
        new Date(order.expectedDeliveryAt).getTime(),
    };
  }, [order?.deliveredAt, order?.expectedDeliveryAt]);

  // Events already arrive ascending; keep that order defensively.
  const events: FoodOrderEvent[] = React.useMemo(
    () =>
      [...(order?.events ?? [])].sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    [order?.events],
  );

  // ── Loading ────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[72px] w-full rounded-lg" />
          ))}
        </div>
        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Skeleton className="h-48 w-full rounded-lg" />
            <Skeleton className="h-64 w-full rounded-lg" />
          </div>
          <Skeleton className="h-80 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  // ── Error / not found ────────────────────────────────────────────────────────
  if (isError || !order) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Order"
          breadcrumbs={[
            { label: "Food", href: "/food" },
            { label: "Orders", href: "/food/orders" },
            { label: id },
          ]}
        />
        <EmptyState
          icon={PackageX}
          title="Order not found"
          description="We couldn't find this order. It may have been removed, or the link is incorrect."
        />
      </div>
    );
  }

  const dispatch = order.dispatch;
  const kitchen = order.kitchen;
  const canAck =
    can("FOOD_KITCHEN_SUMMARY", "edit") && order.status === "PLACED";
  const isPreDispatch =
    order.status === "PLACED" ||
    order.status === "ACCEPTED" ||
    order.status === "PREPARING";
  const canCancel =
    isPreDispatch &&
    (can("FOOD_PLACE_ORDER", "edit") || can("FOOD_KITCHEN_SUMMARY", "edit"));
  // Backend permits editing the people count while PLACED, PREPARING or DISPATCHED
  // (mirrors the PUT handler). Items are recomputed server-side.
  const canEdit =
    (order.status === "PLACED" ||
      order.status === "PREPARING" ||
      order.status === "DISPATCHED") &&
    can("FOOD_PLACE_ORDER", "edit");

  return (
    <div className="space-y-6">
      <PageHeader
        title={order.orderNumber}
        subtitle={`${order.propertyName ?? "—"} · ${MEAL_LABEL[order.mealType]}`}
        breadcrumbs={[
          { label: "Food", href: "/food" },
          { label: "Orders", href: "/food/orders" },
          { label: order.orderNumber },
        ]}
        action={
          <div className="flex items-center gap-2">
            {canAck && (
              <>
                <Button
                  className="bg-success hover:bg-success/90 text-white"
                  onClick={() => acceptMut.mutate()}
                  disabled={acceptMut.isPending || rejectMut.isPending}
                >
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  {acceptMut.isPending ? "Accepting…" : "Accept"}
                </Button>
                <Button
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setRejectOpen(true)}
                  disabled={acceptMut.isPending || rejectMut.isPending}
                >
                  <XCircle className="w-4 h-4 mr-2" /> Reject
                </Button>
              </>
            )}
            {canEdit && (
              <Button
                variant="outline"
                onClick={openEdit}
                disabled={editMut.isPending}
              >
                <Pencil className="w-4 h-4 mr-2" /> Edit order
              </Button>
            )}
            {canCancel && (
              <Button
                variant="outline"
                className="border-warning/40 text-warning hover:bg-warning/10 hover:text-warning"
                onClick={() => setCancelOpen(true)}
                disabled={cancelMut.isPending}
              >
                <Ban className="w-4 h-4 mr-2" /> Cancel order
              </Button>
            )}
          </div>
        }
      />

      {/* Info tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <InfoTile icon={ListChecks} label="Status">
          <div className="flex flex-wrap items-center gap-1.5">
            <OrderStatusBadge status={order.status} />
            {delivery &&
              (delivery.delayed ? (
                <Badge variant="warning" className="gap-1">
                  <AlertTriangle className="w-3 h-3" /> Delayed
                </Badge>
              ) : (
                <Badge variant="success" className="gap-1">
                  <CheckCircle2 className="w-3 h-3" /> On time
                </Badge>
              ))}
          </div>
        </InfoTile>
        <InfoTile icon={Building2} label="Brand">
          {order.brand}
        </InfoTile>
        <InfoTile icon={Package} label="Meal">
          {MEAL_LABEL[order.mealType]}
        </InfoTile>
        <InfoTile icon={Users} label="Residents">
          <span className="tabular-nums">{order.residentsCount}</span>
        </InfoTile>
        <InfoTile icon={Scale} label="Quantity">
          <span className="tabular-nums">{fmtQty(order.totalQuantity)}</span>
        </InfoTile>
        <InfoTile icon={CalendarDays} label="Service date">
          {fmtDate(order.serviceDate)}
        </InfoTile>
      </div>

      {/* Timeline — order journey from placement to delivery (full width, top) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="w-4 h-4 text-accent" /> Timeline
          </CardTitle>
          <CardDescription>Order journey from placement to delivery.</CardDescription>
        </CardHeader>
        <Separator />
        <CardContent className="p-4 sm:p-6">
          <OrderTimeline status={order.status} events={events} />
        </CardContent>
      </Card>

      <div className="space-y-6">
        {/* MAIN */}
        <div className="space-y-6">
          {/* Dispatch details */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Truck className="w-4 h-4 text-accent" /> Dispatch details
              </CardTitle>
              <CardDescription>
                Trip, driver and origin kitchen for this order.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {dispatch ? (
                <div className="space-y-5">
                  <div className="grid sm:grid-cols-2 gap-5">
                    <DispatchRow icon={Hash} label="Dispatch number">
                      <span className="font-mono">{dispatch.dispatchNumber}</span>
                    </DispatchRow>
                    <DispatchRow icon={Truck} label="Vehicle">
                      {dispatch.vehicleNumber || (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </DispatchRow>
                    <DispatchRow icon={User} label="Driver">
                      <div className="flex flex-col">
                        <span>
                          {dispatch.driverName || (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </span>
                        {dispatch.driverPhone && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground font-normal mt-0.5">
                            <Phone className="w-3 h-3" /> {dispatch.driverPhone}
                          </span>
                        )}
                      </div>
                    </DispatchRow>
                    <DispatchRow icon={Clock} label="ETA">
                      {fmtTime(dispatch.estimatedArrivalAt)}
                    </DispatchRow>
                    <DispatchRow icon={Truck} label="Dispatched at">
                      {fmtDateTime(dispatch.dispatchedAt)}
                    </DispatchRow>
                    <DispatchRow icon={ListChecks} label="Trip status">
                      <StatusBadge status={dispatch.status} />
                    </DispatchRow>
                  </div>

                  {kitchen && (
                    <>
                      <Separator />
                      <div className="rounded-lg border border-border bg-muted/30 p-4">
                        <div className="flex items-start gap-3">
                          <div className="h-9 w-9 shrink-0 rounded-md bg-accent/10 flex items-center justify-center">
                            <MapPin className="w-4 h-4 text-accent" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
                              Dispatched from
                            </p>
                            <p className="font-medium mt-0.5">
                              <span className="font-mono text-xs text-accent mr-2">
                                {kitchen.code}
                              </span>
                              {kitchen.name}
                            </p>
                            <p className="text-sm text-muted-foreground mt-1">
                              {[kitchen.address, kitchen.city, kitchen.state]
                                .filter(Boolean)
                                .join(", ") || "—"}
                            </p>
                            {kitchen.pincode && (
                              <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-card border border-border px-2.5 py-1">
                                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                  PIN
                                </span>
                                <span className="font-mono text-sm font-semibold text-foreground tracking-widest">
                                  {kitchen.pincode}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ) : order.dispatchedAt || order.status === "DISPATCHED" || order.status === "DELIVERED" ? (
                <div className="grid sm:grid-cols-2 gap-5">
                  <DispatchRow icon={Truck} label="Dispatched at">
                    {fmtDateTime(order.dispatchedAt)}
                  </DispatchRow>
                  <DispatchRow icon={User} label="Delivery partner">
                    {order.deliveryPartnerName || <span className="text-muted-foreground">—</span>}
                  </DispatchRow>
                  {order.deliveredAt && (
                    <DispatchRow icon={Clock} label="Delivered at">
                      {fmtDateTime(order.deliveredAt)}
                    </DispatchRow>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-3 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                  <Truck className="w-4 h-4" />
                  Not dispatched yet.
                </div>
              )}
            </CardContent>
          </Card>

          {/* Ordered vs Delivered */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Package className="w-4 h-4 text-accent" /> Ordered vs Delivered
              </CardTitle>
              <CardDescription>
                Quantities ordered, received and any shortfall per dish.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {order.items.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                  No items on this order.
                </div>
              ) : (
                <div className="rounded-lg border border-border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Dish</TableHead>
                        <TableHead className="text-right">Ordered</TableHead>
                        <TableHead className="text-right">Received</TableHead>
                        <TableHead className="text-right">Wasted</TableHead>
                        <TableHead className="text-right">Variance</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {order.items.map((it) => {
                        const received =
                          it.receivedQty === null || it.receivedQty === undefined
                            ? null
                            : Number(it.receivedQty);
                        const ordered = Number(it.orderedQty);
                        const variance =
                          received === null ? null : ordered - received;

                        let varianceNode: React.ReactNode;
                        if (variance === null) {
                          varianceNode = (
                            <span className="text-muted-foreground">Pending</span>
                          );
                        } else if (variance > 0) {
                          varianceNode = (
                            <span className="text-destructive font-medium tabular-nums">
                              -{fmtQty(variance, it.unit)}
                            </span>
                          );
                        } else if (variance < 0) {
                          varianceNode = (
                            <span className="text-warning font-medium tabular-nums">
                              +{fmtQty(Math.abs(variance), it.unit)}
                            </span>
                          );
                        } else {
                          varianceNode = (
                            <span className="text-success font-medium">
                              Exact
                            </span>
                          );
                        }

                        return (
                          <TableRow key={it.id}>
                            <TableCell>
                              <span className="font-medium">
                                {it.dishName || it.dishId}
                              </span>
                              {it.component && (
                                <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                                  {it.component}
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {fmtQty(it.orderedQty, it.unit)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {fmtQty(it.receivedQty, it.unit)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {fmtQty(it.wastedQty, it.unit)}
                            </TableCell>
                            <TableCell className="text-right">
                              {varianceNode}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Reject dialog */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XCircle className="w-5 h-5 text-destructive" /> Reject order
            </DialogTitle>
            <DialogDescription>
              The kitchen will not prepare this order. Share a reason so the unit
              lead understands why.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject-reason">Reason</Label>
            <Textarea
              id="reject-reason"
              rows={3}
              placeholder="e.g. Order placed after cut-off, ingredients unavailable…"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRejectOpen(false)}
              disabled={rejectMut.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => rejectMut.mutate()}
              disabled={rejectMut.isPending}
            >
              {rejectMut.isPending ? "Rejecting…" : "Reject order"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel dialog */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Ban className="w-5 h-5 text-warning" /> Cancel order
            </DialogTitle>
            <DialogDescription>
              This order will be cancelled and removed from the kitchen queue.
              Optionally share a reason for the audit trail.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="cancel-reason">Reason (optional)</Label>
            <Textarea
              id="cancel-reason"
              rows={3}
              placeholder="e.g. Residents away, duplicate order…"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCancelOpen(false)}
              disabled={cancelMut.isPending}
            >
              Keep order
            </Button>
            <Button
              variant="destructive"
              onClick={() => cancelMut.mutate()}
              disabled={cancelMut.isPending}
            >
              {cancelMut.isPending ? "Cancelling…" : "Cancel order"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog — people count + notes only. Item quantities are recomputed server-side. */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-accent" /> Edit order
            </DialogTitle>
            <DialogDescription>
              Adjust how many people this meal is prepared for. All dish quantities
              are recalculated automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-residents" className="flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-muted-foreground" />
                Number of People (being prepared for)
              </Label>
              <NumberStepper
                value={editResidents}
                onChange={setEditResidents}
                min={1}
                step={1}
                aria-label="Number of people"
              />
            </div>

            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-accent" />
              <span>
                Changing the people count will{" "}
                <span className="font-medium text-foreground">
                  auto-recalculate every dish quantity
                </span>{" "}
                for this order.
              </span>
            </div>

            {order.status === "DISPATCHED" && (
              <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  This order is already{" "}
                  <span className="font-semibold">dispatched</span>. Saving will
                  notify the kitchen and dispatch that the people count changed and
                  the items were recomputed.
                </span>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="edit-notes">Notes</Label>
              <Textarea
                id="edit-notes"
                rows={3}
                placeholder="Optional notes for the kitchen…"
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setEditOpen(false)}
              disabled={editMut.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => editMut.mutate()}
              disabled={editMut.isPending || !(editResidents > 0)}
            >
              {editMut.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
