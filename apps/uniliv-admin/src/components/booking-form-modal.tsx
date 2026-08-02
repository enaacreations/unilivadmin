import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateBooking,
  useUpdateBooking,
  useGetRooms,
  getGetRoomsQueryKey,
  getGetBookingsQueryKey,
  getGetBookingAvailabilityQueryKey,
  type BookingDto,
  type PropertyDto,
} from "@workspace/api-client-react";
import { FormModal } from "@/components/ui/form-modal";
import { Input } from "@/components/ui/input";
import { ControlledDatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import type { PortfolioAttributes } from "@/lib/portfolio-types";

const schema = z
  .object({
    guestName: z.string().min(1, "Required"),
    guestPhone: z.string().regex(/^\d{10}$/, "10-digit phone"),
    guestEmail: z.string().email("Invalid email").optional().or(z.literal("")),
    guestCount: z.coerce.number().min(1).max(20),
    roomId: z.string().optional(),
    checkInDate: z.string().min(1, "Required"),
    checkOutDate: z.string().min(1, "Required"),
    ratePeriod: z.enum(["NIGHTLY", "WEEKLY"]),
    ratePerPeriod: z.coerce.number().min(0),
    status: z.enum(["CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"]),
    notes: z.string().optional(),
  })
  .refine((v) => new Date(v.checkOutDate) > new Date(v.checkInDate), {
    message: "Check-out must be after check-in",
    path: ["checkOutDate"],
  });

type FormValues = z.infer<typeof schema>;

interface BookingFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  property: PropertyDto;
  booking?: BookingDto | null;
}

function isoDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (isNaN(dt.getTime())) return "";
  return dt.toISOString().slice(0, 10);
}

function diffNights(from: string, to: string): number {
  if (!from || !to) return 0;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

export function BookingFormModal({
  open,
  onOpenChange,
  property,
  booking,
}: BookingFormModalProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const isEdit = !!booking;
  const createMut = useCreateBooking();
  const updateMut = useUpdateBooking();
  const { data: roomsRes } = useGetRooms(
    { propertyId: property.id },
    { query: { queryKey: getGetRoomsQueryKey({ propertyId: property.id }) } },
  );
  const rooms = roomsRes?.data || [];

  const attrs = (property.portfolioAttributes as PortfolioAttributes) || {};
  const defaultNightly = Number(attrs.nightlyRate || 0);
  const defaultWeekly = Number(attrs.weeklyRate || 0);

  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);

  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      guestName: "",
      guestPhone: "",
      guestEmail: "",
      guestCount: 1,
      roomId: "",
      checkInDate: isoDate(today),
      checkOutDate: isoDate(tomorrow),
      ratePeriod: "NIGHTLY",
      ratePerPeriod: defaultNightly,
      status: "CONFIRMED",
      notes: "",
    },
  });

  React.useEffect(() => {
    if (!open) return;
    if (booking) {
      reset({
        guestName: booking.guestName,
        guestPhone: booking.guestPhone,
        guestEmail: booking.guestEmail || "",
        guestCount: booking.guestCount,
        roomId: booking.roomId || "",
        checkInDate: isoDate(booking.checkInDate),
        checkOutDate: isoDate(booking.checkOutDate),
        ratePeriod: (booking.ratePeriod as "NIGHTLY" | "WEEKLY") || "NIGHTLY",
        ratePerPeriod: Number(booking.ratePerPeriod) || 0,
        status: (booking.status as FormValues["status"]) || "CONFIRMED",
        notes: booking.notes || "",
      });
    } else {
      reset({
        guestName: "",
        guestPhone: "",
        guestEmail: "",
        guestCount: 1,
        roomId: "",
        checkInDate: isoDate(today),
        checkOutDate: isoDate(tomorrow),
        ratePeriod: "NIGHTLY",
        ratePerPeriod: defaultNightly,
        status: "CONFIRMED",
        notes: "",
      });
    }
  }, [open, booking, reset, defaultNightly]);

  const ratePeriod = watch("ratePeriod");
  const ratePerPeriod = Number(watch("ratePerPeriod") || 0);
  const checkInDate = watch("checkInDate");
  const checkOutDate = watch("checkOutDate");
  const nights = diffNights(checkInDate, checkOutDate);
  const units = ratePeriod === "WEEKLY" ? Math.max(1, Math.ceil(nights / 7)) : nights;
  const total = units * ratePerPeriod;

  React.useEffect(() => {
    if (isEdit) return;
    setValue(
      "ratePerPeriod",
      ratePeriod === "WEEKLY" ? defaultWeekly : defaultNightly,
    );
  }, [ratePeriod, defaultWeekly, defaultNightly, isEdit, setValue]);

  const onSubmit = async (values: FormValues) => {
    if (values.ratePerPeriod <= 0) {
      toast({
        title: "Set a rate (or configure nightly/weekly rate on the property)",
        variant: "destructive",
      });
      return;
    }
    const body = {
      propertyId: property.id,
      roomId: values.roomId || undefined,
      guestName: values.guestName,
      guestPhone: values.guestPhone,
      guestEmail: values.guestEmail || undefined,
      guestCount: values.guestCount,
      checkInDate: new Date(values.checkInDate).toISOString(),
      checkOutDate: new Date(values.checkOutDate).toISOString(),
      ratePeriod: values.ratePeriod,
      ratePerPeriod: values.ratePerPeriod,
      status: values.status,
      notes: values.notes || undefined,
    };
    try {
      if (isEdit && booking) {
        await updateMut.mutateAsync({ id: booking.id, data: body });
        toast({ title: "Booking updated" });
      } else {
        await createMut.mutateAsync({ data: body });
        toast({ title: "Booking created" });
      }
      qc.invalidateQueries({
        queryKey: getGetBookingsQueryKey({ propertyId: property.id }),
      });
      qc.invalidateQueries({ queryKey: ["bookings"], exact: false });
      qc.invalidateQueries({
        queryKey: getGetBookingAvailabilityQueryKey({
          propertyId: property.id,
          from: "",
          to: "",
        }).slice(0, -1),
      });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  };

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "Edit Booking" : "New Booking"}
      onSave={handleSubmit(onSubmit)}
      isSaving={createMut.isPending || updateMut.isPending}
      saveLabel={isEdit ? "Save Changes" : "Create Booking"}
    >
      <div className="space-y-4">
        <div>
          <Label>Guest Name *</Label>
          <Input data-testid="input-booking-guest-name" {...register("guestName")} />
          {errors.guestName && (
            <p className="text-xs text-destructive">{errors.guestName.message}</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Phone *</Label>
            <Input data-testid="input-booking-phone" {...register("guestPhone")} />
            {errors.guestPhone && (
              <p className="text-xs text-destructive">{errors.guestPhone.message}</p>
            )}
          </div>
          <div>
            <Label>Email</Label>
            <Input data-testid="input-booking-email" {...register("guestEmail")} />
            {errors.guestEmail && (
              <p className="text-xs text-destructive">{errors.guestEmail.message}</p>
            )}
          </div>
          <div>
            <Label>Guests</Label>
            <Input
              type="number"
              min={1}
              data-testid="input-booking-guest-count"
              {...register("guestCount")}
            />
          </div>
          <div>
            <Label>Room</Label>
            <Select
              value={watch("roomId") || "__none"}
              onValueChange={(v) => setValue("roomId", v === "__none" ? "" : v)}
            >
              <SelectTrigger data-testid="select-booking-room">
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">Unassigned</SelectItem>
                {rooms.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.number} · Floor {r.floor}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Check-in *</Label>
            <ControlledDatePicker
              control={control}
              name="checkInDate"
              data-testid="input-booking-checkin"
            />
            {errors.checkInDate && (
              <p className="text-xs text-destructive">{errors.checkInDate.message}</p>
            )}
          </div>
          <div>
            <Label>Check-out *</Label>
            <ControlledDatePicker
              control={control}
              name="checkOutDate"
              data-testid="input-booking-checkout"
            />
            {errors.checkOutDate && (
              <p className="text-xs text-destructive">{errors.checkOutDate.message}</p>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Rate period</Label>
            <Select
              value={ratePeriod}
              onValueChange={(v) => setValue("ratePeriod", v as "NIGHTLY" | "WEEKLY")}
            >
              <SelectTrigger data-testid="select-booking-rate-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NIGHTLY">Nightly</SelectItem>
                <SelectItem value="WEEKLY">Weekly</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Rate (₹) per {ratePeriod === "WEEKLY" ? "week" : "night"}</Label>
            <Input
              type="number"
              min={0}
              data-testid="input-booking-rate"
              {...register("ratePerPeriod")}
            />
          </div>
        </div>
        <div>
          <Label>Status</Label>
          <Select
            value={watch("status")}
            onValueChange={(v) => setValue("status", v as FormValues["status"])}
          >
            <SelectTrigger data-testid="select-booking-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="CONFIRMED">Confirmed</SelectItem>
              <SelectItem value="CHECKED_IN">Checked-in</SelectItem>
              <SelectItem value="CHECKED_OUT">Checked-out</SelectItem>
              <SelectItem value="CANCELLED">Cancelled</SelectItem>
              <SelectItem value="NO_SHOW">No-show</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Notes</Label>
          <Textarea data-testid="input-booking-notes" rows={2} {...register("notes")} />
        </div>
        <div
          className="border rounded-lg p-3 bg-surface space-y-1 text-sm"
          data-testid="booking-invoice-preview"
        >
          <div className="font-display font-semibold text-primary">Invoice preview</div>
          <div className="flex justify-between text-muted-foreground">
            <span>Nights</span>
            <span>{nights}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>
              {units} × ₹{ratePerPeriod || 0} {ratePeriod === "WEEKLY" ? "/ week" : "/ night"}
            </span>
            <span>₹{(units * (ratePerPeriod || 0)).toFixed(0)}</span>
          </div>
          <div className="flex justify-between font-semibold text-primary border-t pt-1">
            <span>Total</span>
            <span data-testid="booking-invoice-total">₹{total.toFixed(0)}</span>
          </div>
        </div>
      </div>
    </FormModal>
  );
}
