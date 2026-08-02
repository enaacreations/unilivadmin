import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateResident,
  useGetProperties,
  getGetPropertiesQueryKey,
  useGetRooms,
  getGetRoomsQueryKey,
  getGetResidentsQueryKey,
} from "@workspace/api-client-react";
import { FormModal } from "@/components/ui/form-modal";
import { Input } from "@/components/ui/input";
import { ControlledDatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileUpload } from "@/components/ui/file-upload";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ChevronLeft, ChevronRight, Check, X, FileText } from "lucide-react";
import jsPDF from "jspdf";

const DIETARY = ["VEG", "JAIN", "VEGAN", "NON_VEG"];

const step1Schema = z.object({
  name: z.string().min(1, "Required"),
  phone: z.string().regex(/^\d{10}$/, "10-digit phone"),
  email: z.string().email("Invalid email"),
  dob: z.string().optional(),
  gender: z.string().optional(),
  college: z.string().optional(),
  course: z.string().optional(),
});
const step2Schema = z.object({
  propertyId: z.string().min(1, "Required"),
  roomId: z.string().min(1, "Required"),
  checkInDate: z.string().min(1, "Required"),
  planType: z.string().optional(),
  monthlyRent: z.coerce.number().min(0),
  securityDeposit: z.coerce.number().min(0),
});
const step3Schema = z.object({
  parentName: z.string().optional(),
  parentPhone: z.string().optional(),
  parentEmail: z.string().optional(),
  emergencyContact: z.string().optional(),
});

interface ResidentFormModalProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

export function ResidentFormModal({ open, onOpenChange }: ResidentFormModalProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const createMut = useCreateResident();
  const [step, setStep] = React.useState(1);
  const [dietary, setDietary] = React.useState<string[]>([]);
  const [allergies, setAllergies] = React.useState<string[]>([]);
  const [allergyInput, setAllergyInput] = React.useState("");
  const [data1, setData1] = React.useState<any>({});
  const [data2, setData2] = React.useState<any>({});

  const { data: propsRes } = useGetProperties(undefined, {
    query: { queryKey: getGetPropertiesQueryKey() },
  });
  const properties = propsRes?.data || [];

  const form1 = useForm({ resolver: zodResolver(step1Schema), defaultValues: { name: "", phone: "", email: "", dob: "", gender: "", college: "", course: "" } });
  const form2 = useForm({ resolver: zodResolver(step2Schema), defaultValues: { propertyId: "", roomId: "", checkInDate: "", planType: "MONTHLY", monthlyRent: 0, securityDeposit: 0 } });
  const form3 = useForm({ resolver: zodResolver(step3Schema), defaultValues: { parentName: "", parentPhone: "", parentEmail: "", emergencyContact: "" } });

  const propertyId = form2.watch("propertyId");
  const { data: roomsRes } = useGetRooms(
    { propertyId },
    { query: { queryKey: getGetRoomsQueryKey({ propertyId }), enabled: !!propertyId } }
  );
  const availableRooms = (roomsRes?.data || []).filter(
    (r) => r.status === "VACANT" || (r.capacity || 0) > (r.occupancy || 0)
  );

  React.useEffect(() => {
    if (open) {
      setStep(1);
      setDietary([]);
      setAllergies([]);
      setAllergyInput("");
      setData1({});
      setData2({});
      form1.reset();
      form2.reset();
      form3.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const next1 = form1.handleSubmit((v) => {
    setData1(v);
    setStep(2);
  });
  const next2 = form2.handleSubmit((v) => {
    setData2(v);
    setStep(3);
  });

  const onSubmit = form3.handleSubmit(async (v3) => {
    try {
      const body: any = {
        ...data1,
        ...data2,
        ...v3,
        monthlyRent: Number(data2.monthlyRent),
        securityDeposit: Number(data2.securityDeposit),
        dietaryPref: dietary,
        dob: data1.dob || undefined,
        gender: data1.gender || undefined,
        college: data1.college || undefined,
        course: data1.course || undefined,
        parentEmail: v3.parentEmail || undefined,
      };
      Object.keys(body).forEach((k) => body[k] === "" && delete body[k]);
      await createMut.mutateAsync({ data: body });
      toast({ title: "Resident created" });
      qc.invalidateQueries({ queryKey: getGetResidentsQueryKey() });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  });

  const previewAgreement = () => {
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text("Tenancy Agreement (Preview)", 20, 20);
    doc.setFontSize(11);
    const v1 = form1.getValues();
    const v2 = form2.getValues();
    const property = properties.find((p) => p.id === v2.propertyId);
    const room = availableRooms.find((r) => r.id === v2.roomId);
    let y = 40;
    [
      `Name: ${v1.name}`,
      `Phone: ${v1.phone}`,
      `Email: ${v1.email}`,
      `Property: ${property?.name || "—"}`,
      `Room: ${room?.number || "—"}`,
      `Check-in: ${v2.checkInDate}`,
      `Monthly Rent: Rs ${v2.monthlyRent}`,
      `Security Deposit: Rs ${v2.securityDeposit}`,
      `Plan: ${v2.planType}`,
    ].forEach((line) => {
      doc.text(line, 20, y);
      y += 8;
    });
    window.open(doc.output("bloburl"), "_blank");
  };

  const Stepper = () => (
    <div className="flex items-center justify-between mb-6">
      {[
        { n: 1, label: "Personal" },
        { n: 2, label: "Accommodation" },
        { n: 3, label: "Emergency & Docs" },
      ].map((s, i, arr) => (
        <React.Fragment key={s.n}>
          <div className="flex items-center gap-2">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${step >= s.n ? "bg-accent text-white" : "bg-surface text-muted-foreground"}`}>
              {step > s.n ? <Check className="w-3.5 h-3.5" /> : s.n}
            </div>
            <span className={`text-xs font-medium ${step === s.n ? "text-accent" : "text-muted-foreground"}`}>{s.label}</span>
          </div>
          {i < arr.length - 1 && <div className="flex-1 h-px bg-border mx-2" />}
        </React.Fragment>
      ))}
    </div>
  );

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title="Add Resident"
      showFooter={false}
    >
      <Stepper />

      {step === 1 && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Name *</Label>
              <Input data-testid="input-resident-name" {...form1.register("name")} />
              {form1.formState.errors.name && <p className="text-xs text-destructive">{form1.formState.errors.name.message}</p>}
            </div>
            <div>
              <Label>Phone *</Label>
              <Input type="tel" inputMode="numeric" maxLength={10} placeholder="10-digit number" data-testid="input-resident-phone" {...form1.register("phone")} />
              {form1.formState.errors.phone && <p className="text-xs text-destructive">{form1.formState.errors.phone.message}</p>}
            </div>
            <div className="col-span-2">
              <Label>Email *</Label>
              <Input type="email" autoComplete="email" placeholder="name@example.com" data-testid="input-resident-email" {...form1.register("email")} />
              {form1.formState.errors.email && <p className="text-xs text-destructive">{form1.formState.errors.email.message}</p>}
            </div>
            <div>
              <Label>Date of Birth</Label>
              <ControlledDatePicker control={form1.control} name="dob" />
            </div>
            <div>
              <Label>Gender</Label>
              <Select value={form1.watch("gender")} onValueChange={(v) => form1.setValue("gender", v)}>
                <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Male">Male</SelectItem>
                  <SelectItem value="Female">Female</SelectItem>
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>College</Label>
              <Input {...form1.register("college")} />
            </div>
            <div>
              <Label>Course</Label>
              <Input {...form1.register("course")} />
            </div>
          </div>
          <div>
            <Label>Photo</Label>
            <FileUpload onFileSelect={() => {}} />
          </div>
          <div>
            <Label>Dietary Preference</Label>
            <div className="flex flex-wrap gap-2 mt-2">
              {DIETARY.map((d) => {
                const active = dietary.includes(d);
                return (
                  <Badge key={d} variant={active ? "default" : "outline"} className={`cursor-pointer ${active ? "bg-accent text-white" : ""}`} onClick={() => setDietary((p) => active ? p.filter((x) => x !== d) : [...p, d])}>
                    {d}
                  </Badge>
                );
              })}
            </div>
          </div>
          <div>
            <Label>Allergies</Label>
            <div className="flex gap-2 mt-1">
              <Input
                value={allergyInput}
                onChange={(e) => setAllergyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    const v = allergyInput.trim().replace(/,$/, "");
                    if (v) setAllergies((p) => [...p, v]);
                    setAllergyInput("");
                  }
                }}
                placeholder="Type and press Enter"
              />
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
              {allergies.map((a, i) => (
                <Badge key={i} variant="secondary" className="gap-1">
                  {a}
                  <X className="w-3 h-3 cursor-pointer" onClick={() => setAllergies((p) => p.filter((_, idx) => idx !== i))} />
                </Badge>
              ))}
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div>
            <Label>Property *</Label>
            <Select value={form2.watch("propertyId")} onValueChange={(v) => { form2.setValue("propertyId", v); form2.setValue("roomId", ""); }}>
              <SelectTrigger data-testid="select-resident-property"><SelectValue placeholder="Select property" /></SelectTrigger>
              <SelectContent>
                {properties.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
              </SelectContent>
            </Select>
            {form2.formState.errors.propertyId && <p className="text-xs text-destructive">{form2.formState.errors.propertyId.message}</p>}
          </div>
          <div>
            <Label>Room *</Label>
            <Select value={form2.watch("roomId")} onValueChange={(v) => form2.setValue("roomId", v)} disabled={!propertyId}>
              <SelectTrigger data-testid="select-resident-room"><SelectValue placeholder={propertyId ? "Select room" : "Pick property first"} /></SelectTrigger>
              <SelectContent>
                {availableRooms.map((r) => (
                  <SelectItem key={r.id} value={r.id}>{r.number} ({r.type}, {r.occupancy}/{r.capacity})</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form2.formState.errors.roomId && <p className="text-xs text-destructive">{form2.formState.errors.roomId.message}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Check-in Date *</Label>
              <ControlledDatePicker control={form2.control} name="checkInDate" />
              {form2.formState.errors.checkInDate && <p className="text-xs text-destructive">{form2.formState.errors.checkInDate.message}</p>}
            </div>
            <div>
              <Label>Plan Type</Label>
              <Select value={form2.watch("planType")} onValueChange={(v) => form2.setValue("planType", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MONTHLY">Monthly</SelectItem>
                  <SelectItem value="QUARTERLY">Quarterly</SelectItem>
                  <SelectItem value="ANNUAL">Annual</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Monthly Rent (₹) *</Label>
              <Input type="number" {...form2.register("monthlyRent")} />
            </div>
            <div>
              <Label>Security Deposit (₹) *</Label>
              <Input type="number" {...form2.register("securityDeposit")} />
            </div>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Parent Name</Label>
              <Input {...form3.register("parentName")} />
            </div>
            <div>
              <Label>Parent Phone</Label>
              <Input {...form3.register("parentPhone")} />
            </div>
            <div className="col-span-2">
              <Label>Parent Email</Label>
              <Input {...form3.register("parentEmail")} />
            </div>
            <div className="col-span-2">
              <Label>Emergency Contact</Label>
              <Input {...form3.register("emergencyContact")} />
            </div>
          </div>
          <div>
            <Label>Documents</Label>
            <div className="grid grid-cols-2 gap-3 mt-2">
              {["Aadhar", "College ID", "Photo ID", "Agreement"].map((d) => (
                <div key={d} className="border border-dashed rounded-lg p-3 text-center bg-surface">
                  <FileText className="w-6 h-6 mx-auto text-muted-foreground" />
                  <p className="text-xs mt-1 font-medium">{d}</p>
                  <p className="text-[10px] text-muted-foreground">Click to upload</p>
                </div>
              ))}
            </div>
          </div>
          <Button variant="outline" type="button" onClick={previewAgreement} className="w-full" data-testid="button-preview-agreement">
            <FileText className="w-4 h-4 mr-2" /> Preview Generated Agreement
          </Button>
        </div>
      )}

      <div className="sticky bottom-0 bg-surface pt-4 mt-6 border-t flex items-center justify-between">
        {step > 1 ? (
          <Button variant="outline" onClick={() => setStep(step - 1)} data-testid="button-step-back">
            <ChevronLeft className="w-4 h-4 mr-1" /> Back
          </Button>
        ) : <div />}
        {step < 3 ? (
          <Button
            className="bg-accent hover:bg-accent/90 text-white"
            onClick={step === 1 ? next1 : next2}
            data-testid="button-step-next"
          >
            Next <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        ) : (
          <Button
            className="bg-accent hover:bg-accent/90 text-white"
            onClick={onSubmit}
            disabled={createMut.isPending}
            data-testid="button-submit-resident"
          >
            Create Resident
          </Button>
        )}
      </div>
    </FormModal>
  );
}
