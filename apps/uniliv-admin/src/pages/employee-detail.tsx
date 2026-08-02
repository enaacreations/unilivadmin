import * as React from "react";
import {
  useGetEmployee,
  getGetEmployeeQueryKey,
  useGetEmployees,
  getGetEmployeesQueryKey,
  useGetProperties,
  getGetPropertiesQueryKey,
  useGetLeaves,
  getGetLeavesQueryKey,
  useCreateLeave,
  useUpdateLeave,
  useMarkAttendance,
  useUpdateAttendance,
} from "@workspace/api-client-react";
import { useParams } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { apiFetch } from "@/lib/api-fetch";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { UserAvatar } from "@/components/ui/user-avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker, ControlledDatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import { FormModal } from "@/components/ui/form-modal";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LogOut, Plus, Check, X, FileText, Award, AlertTriangle, MessageSquare, FileCheck2, FileClock } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/hooks/use-toast";

const ATTENDANCE_STATUSES = ["PRESENT", "ABSENT", "HALF_DAY", "WFH", "ON_LEAVE"];
const LEAVE_TYPES = ["CL", "SL", "EL", "PL", "COMP_OFF"];

const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  PRESENT: { label: "P", cls: "bg-success/20 text-success" },
  ABSENT: { label: "A", cls: "bg-destructive/20 text-destructive" },
  HALF_DAY: { label: "H", cls: "bg-warning/20 text-warning" },
  WFH: { label: "W", cls: "bg-blue-100 text-blue-700" },
  ON_LEAVE: { label: "L", cls: "bg-amber-100 text-amber-700" },
};

function workingDaysBetween(from: string, to: string): number {
  if (!from || !to) return 0;
  const start = new Date(from);
  const end = new Date(to);
  let n = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0) n++;
  }
  return n;
}

function maskAccount(s?: string | null) {
  if (!s) return "—";
  if (s.length <= 4) return s;
  return `${"X".repeat(s.length - 4)}${s.slice(-4)}`;
}

export default function EmployeeDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id as string;
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: empRes, isLoading } = useGetEmployee(id, {
    query: { queryKey: getGetEmployeeQueryKey(id), enabled: !!id },
  });
  const employee = empRes?.data;

  const { data: propsRes } = useGetProperties(undefined, { query: { queryKey: getGetPropertiesQueryKey() } });
  const properties = propsRes?.data || [];
  const { data: empsRes } = useGetEmployees(undefined, { query: { queryKey: getGetEmployeesQueryKey() } });
  const allEmployees = empsRes?.data || [];

  const propertyName = (pid?: string | null) => properties.find((p) => p.id === pid)?.name || "—";
  const employeeName = (eid?: string | null) => allEmployees.find((e) => e.id === eid)?.name || "—";

  const [tab, setTab] = React.useState("profile");
  const [exitOpen, setExitOpen] = React.useState(false);

  if (isLoading) {
    return <div className="space-y-6"><Skeleton className="h-32 w-full" /><Skeleton className="h-96 w-full" /></div>;
  }
  if (!employee) {
    return <div className="text-muted-foreground">Employee not found</div>;
  }

  return (
    <div className="space-y-6">

      <div className="flex justify-between items-start gap-4">
        <div className="flex items-center gap-4">
          <UserAvatar name={employee.name} src={employee.photo || undefined} className="h-16 w-16" fallbackClassName="text-2xl" />
          <div>
            <h1 className="text-3xl font-display font-bold tracking-tight text-primary">{employee.name}</h1>
            <p className="text-muted-foreground text-sm flex items-center gap-2 mt-1 flex-wrap">
              <span className="font-mono bg-muted/30 px-2 py-0.5 rounded text-xs">{employee.employeeCode}</span>
              <span>{employee.designation} · {employee.department}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={employee.status} />
          {employee.status === "ACTIVE" && (
            <Button
              variant="outline"
              className="text-destructive border-destructive/30 hover:bg-destructive/10"
              onClick={() => setExitOpen(true)}
              data-testid="button-initiate-exit"
            >
              <LogOut className="w-4 h-4 mr-2" /> Initiate Exit
            </Button>
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-surface border w-fit">
          {["profile", "attendance", "leave", "performance", "documents", "exit"].map((t) => (
            <TabsTrigger key={t} value={t} className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground capitalize">
              {t}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="profile" className="mt-6">
          <ProfileTab employee={employee} propertyName={propertyName} managerName={employeeName(employee.managerId)} />
        </TabsContent>

        <TabsContent value="attendance" className="mt-6">
          <AttendanceTab employeeId={id} />
        </TabsContent>

        <TabsContent value="leave" className="mt-6">
          <LeaveTab employeeId={id} />
        </TabsContent>

        <TabsContent value="performance" className="mt-6">
          <PerformanceTab employeeId={id} />
        </TabsContent>

        <TabsContent value="documents" className="mt-6">
          <DocumentsTab employee={employee} onSwitchTab={setTab} />
        </TabsContent>

        <TabsContent value="exit" className="mt-6">
          <ExitTab employeeId={id} onSwitchTab={setTab} />
        </TabsContent>
      </Tabs>

      <ExitInitiateModal
        open={exitOpen}
        onOpenChange={setExitOpen}
        employeeId={id}
        onCreated={() => {
          qc.invalidateQueries({ queryKey: ["emp-exit", id] });
          qc.invalidateQueries({ queryKey: getGetEmployeeQueryKey(id) });
          setTab("exit");
          toast({ title: "Exit initiated" });
        }}
      />
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-start text-sm py-1.5 border-b last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-primary text-right">{value || "—"}</span>
    </div>
  );
}

function ProfileTab({ employee, propertyName, managerName }: { employee: any; propertyName: (id?: string | null) => string; managerName: string }) {
  const hasComp = employee.ctc || employee.basic || employee.hra || employee.specialAllowance;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <Card className="shadow-sm">
        <CardContent className="p-5">
          <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Personal</p>
          <InfoRow label="Date of Birth" value={employee.dob ? new Date(employee.dob).toLocaleDateString() : null} />
          <InfoRow label="Gender" value={employee.gender} />
          <InfoRow label="Phone" value={employee.phone} />
          <InfoRow label="Email" value={employee.email} />
        </CardContent>
      </Card>
      <Card className="shadow-sm">
        <CardContent className="p-5">
          <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Employment</p>
          <InfoRow label="Joining Date" value={new Date(employee.joiningDate).toLocaleDateString()} />
          <InfoRow label="Manager" value={managerName} />
          <InfoRow label="Property" value={propertyName(employee.propertyId)} />
          <InfoRow label="Department" value={employee.department} />
        </CardContent>
      </Card>
      {hasComp && (
        <Card className="shadow-sm">
          <CardContent className="p-5">
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Compensation</p>
            {employee.ctc && <InfoRow label="CTC (Annual)" value={`Rs ${Number(employee.ctc).toLocaleString("en-IN")}`} />}
            {employee.basic && <InfoRow label="Basic" value={`Rs ${Number(employee.basic).toLocaleString("en-IN")}`} />}
            {employee.hra && <InfoRow label="HRA" value={`Rs ${Number(employee.hra).toLocaleString("en-IN")}`} />}
            {employee.specialAllowance && <InfoRow label="Special" value={`Rs ${Number(employee.specialAllowance).toLocaleString("en-IN")}`} />}
          </CardContent>
        </Card>
      )}
      <Card className="shadow-sm">
        <CardContent className="p-5">
          <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Banking & Compliance</p>
          <InfoRow label="PAN" value={employee.panNumber} />
          <InfoRow label="PF Number" value={employee.pfNumber} />
          <InfoRow label="ESIC Number" value={employee.esicNumber} />
          <InfoRow label="Bank Account" value={maskAccount(employee.bankAccount)} />
          <InfoRow label="IFSC" value={employee.ifscCode} />
        </CardContent>
      </Card>
    </div>
  );
}

// Standard HR document checklist. The backend currently has no document-storage
// endpoint or table, so uploads aren't available yet. We surface the standard
// expected document set and reflect which compliance identifiers are already on
// file from the employee record (captured in the Profile tab) so this tab is an
// honest, informative status view rather than a dead placeholder.
function DocumentsTab({ employee, onSwitchTab }: { employee: any; onSwitchTab: (t: string) => void }) {
  const docs: Array<{ label: string; onFile: boolean; detail?: string }> = [
    { label: "ID Proof (Aadhaar / Passport)", onFile: false },
    { label: "Address Proof", onFile: false },
    {
      label: "PAN Card",
      onFile: !!employee.panNumber,
      detail: employee.panNumber ? `PAN ${employee.panNumber} on file` : undefined,
    },
    { label: "Offer Letter", onFile: false },
    { label: "Appointment Letter", onFile: false },
    {
      label: "Bank Account Proof (Cancelled Cheque)",
      onFile: !!employee.bankAccount,
      detail: employee.bankAccount ? `Account ${maskAccount(employee.bankAccount)} on file` : undefined,
    },
    {
      label: "PF Details",
      onFile: !!employee.pfNumber,
      detail: employee.pfNumber ? `PF ${employee.pfNumber} on file` : undefined,
    },
    {
      label: "ESIC Details",
      onFile: !!employee.esicNumber,
      detail: employee.esicNumber ? `ESIC ${employee.esicNumber} on file` : undefined,
    },
    { label: "Educational Certificates", onFile: false },
    { label: "Experience / Relieving Letters", onFile: false },
  ];

  const onFileCount = docs.filter((d) => d.onFile).length;

  return (
    <div className="space-y-4">
      <EmptyState
        icon={FileText}
        title="No documents uploaded yet"
        description="File uploads aren't available for employee records yet. The standard document checklist below shows what HR expects to collect; compliance identifiers already captured on the profile are marked as on file."
        action={
          <Button variant="outline" onClick={() => onSwitchTab("profile")}>
            View profile details
          </Button>
        }
      />

      <Card className="shadow-sm">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Standard Document Checklist</p>
            <Badge variant="outline" className="text-xs">{onFileCount}/{docs.length} on file</Badge>
          </div>
          <div className="space-y-2">
            {docs.map((d) => (
              <div key={d.label} className="flex items-center justify-between border rounded-lg p-3">
                <div className="flex items-center gap-3">
                  {d.onFile ? (
                    <FileCheck2 className="w-4 h-4 text-success shrink-0" />
                  ) : (
                    <FileClock className="w-4 h-4 text-muted-foreground/50 shrink-0" />
                  )}
                  <div>
                    <span className="text-sm font-medium text-primary">{d.label}</span>
                    {d.detail && <p className="text-xs text-muted-foreground">{d.detail}</p>}
                  </div>
                </div>
                {d.onFile ? (
                  <Badge variant="outline" className="text-success border-success/30 text-[10px] uppercase tracking-wider">On file</Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground text-[10px] uppercase tracking-wider">Not uploaded</Badge>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface AttendanceRow {
  id: string;
  date: string;
  status: string;
  inTime?: string | null;
  outTime?: string | null;
  notes?: string | null;
}

function AttendanceTab({ employeeId }: { employeeId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const today = new Date();
  const [year, setYear] = React.useState(today.getFullYear());
  const [month, setMonth] = React.useState(today.getMonth() + 1);

  const { data: attRes, isLoading } = useQuery({
    queryKey: ["emp-attendance", employeeId, year, month],
    queryFn: () => apiFetch<{ success: boolean; data: AttendanceRow[] }>(`/employees/${employeeId}/attendance?year=${year}&month=${month}`),
  });
  const records = attRes?.data || [];

  const byDay: Record<number, AttendanceRow> = {};
  for (const r of records) byDay[new Date(r.date).getDate()] = r;

  const counts = { PRESENT: 0, ABSENT: 0, ON_LEAVE: 0 };
  for (const r of records) if ((counts as any)[r.status] !== undefined) (counts as any)[r.status]++;

  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDay = new Date(year, month - 1, 1).getDay();

  const [editDay, setEditDay] = React.useState<number | null>(null);
  const [editStatus, setEditStatus] = React.useState("PRESENT");
  const [editIn, setEditIn] = React.useState("");
  const [editOut, setEditOut] = React.useState("");
  const [editNotes, setEditNotes] = React.useState("");

  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [bulkFrom, setBulkFrom] = React.useState("");
  const [bulkTo, setBulkTo] = React.useState("");
  const [bulkStatus, setBulkStatus] = React.useState("PRESENT");

  const createMut = useMarkAttendance();
  const updateMut = useUpdateAttendance();

  const hhmm = (iso?: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  const openDay = (day: number) => {
    const rec = byDay[day];
    setEditDay(day);
    setEditStatus(rec?.status || "PRESENT");
    setEditIn(hhmm(rec?.inTime));
    setEditOut(hhmm(rec?.outTime));
    setEditNotes(rec?.notes || "");
  };

  const saveDay = async () => {
    if (editDay == null) return;
    const date = new Date(year, month - 1, editDay).toISOString().slice(0, 10);
    const rec = byDay[editDay];
    const body: any = { employeeId, date, status: editStatus };
    if (editIn) body.inTime = `${date}T${editIn}:00`;
    if (editOut) body.outTime = `${date}T${editOut}:00`;
    if (editNotes) body.notes = editNotes;
    try {
      if (rec) await updateMut.mutateAsync({ id: rec.id, data: body });
      else await createMut.mutateAsync({ data: body });
      toast({ title: "Attendance saved" });
      qc.invalidateQueries({ queryKey: ["emp-attendance", employeeId, year, month] });
      setEditDay(null);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  };

  const submitBulk = async () => {
    if (!bulkFrom || !bulkTo) {
      toast({ title: "Pick both dates" });
      return;
    }
    try {
      const start = new Date(bulkFrom);
      const end = new Date(bulkTo);
      let count = 0;
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (d.getDay() === 0) continue;
        await apiFetch("/attendance/bulk", {
          method: "POST",
          body: JSON.stringify({
            employeeIds: [employeeId],
            date: d.toISOString().slice(0, 10),
            status: bulkStatus,
          }),
        });
        count++;
      }
      toast({ title: `Marked ${count} day(s)` });
      qc.invalidateQueries({ queryKey: ["emp-attendance", employeeId, year, month] });
      setBulkOpen(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  };

  const years = [today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1];
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex gap-2">
          <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              {months.map((m, i) => (<SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>))}
            </SelectContent>
          </Select>
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              {years.map((y) => (<SelectItem key={y} value={String(y)}>{y}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" onClick={() => setBulkOpen(true)} data-testid="button-bulk-mark">Bulk mark range</Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="shadow-sm"><CardContent className="p-4"><p className="text-xs text-muted-foreground uppercase tracking-wider">Present</p><p className="text-2xl font-display font-bold text-success">{counts.PRESENT}</p></CardContent></Card>
        <Card className="shadow-sm"><CardContent className="p-4"><p className="text-xs text-muted-foreground uppercase tracking-wider">Absent</p><p className="text-2xl font-display font-bold text-destructive">{counts.ABSENT}</p></CardContent></Card>
        <Card className="shadow-sm"><CardContent className="p-4"><p className="text-xs text-muted-foreground uppercase tracking-wider">On Leave</p><p className="text-2xl font-display font-bold text-amber-600">{counts.ON_LEAVE}</p></CardContent></Card>
      </div>

      <Card className="shadow-sm">
        <CardContent className="p-4">
          {isLoading ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <div>
              <div className="grid grid-cols-7 gap-2 mb-2">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                  <div key={d} className="text-xs text-muted-foreground uppercase tracking-wider text-center font-medium">{d}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-2">
                {Array.from({ length: firstDay }).map((_, i) => <div key={`p${i}`} />)}
                {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => {
                  const rec = byDay[day];
                  const chip = rec ? STATUS_CHIP[rec.status] : null;
                  return (
                    <button
                      key={day}
                      onClick={() => openDay(day)}
                      className="border rounded-md p-2 text-left hover:border-accent/50 transition-colors bg-card min-h-[64px]"
                      data-testid={`day-${day}`}
                    >
                      <div className="text-xs text-muted-foreground">{day}</div>
                      {chip ? (
                        <span className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] font-bold ${chip.cls}`}>{chip.label}</span>
                      ) : (
                        <span className="inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-muted/30 text-muted-foreground">-</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <FormModal
        open={editDay != null}
        onOpenChange={(o) => { if (!o) setEditDay(null); }}
        title={`Attendance — ${editDay ? new Date(year, month - 1, editDay).toLocaleDateString() : ""}`}
        onSave={saveDay}
        isSaving={createMut.isPending || updateMut.isPending}
      >
        <div className="space-y-4">
          <div>
            <Label>Status</Label>
            <Select value={editStatus} onValueChange={setEditStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ATTENDANCE_STATUSES.map((s) => (<SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>In Time</Label><Input type="time" value={editIn} onChange={(e) => setEditIn(e.target.value)} /></div>
            <div><Label>Out Time</Label><Input type="time" value={editOut} onChange={(e) => setEditOut(e.target.value)} /></div>
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea rows={3} value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
          </div>
        </div>
      </FormModal>

      <FormModal
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        title="Bulk mark attendance"
        onSave={submitBulk}
        saveLabel="Mark"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>From *</Label><DatePicker value={bulkFrom} onChange={setBulkFrom} /></div>
            <div><Label>To *</Label><DatePicker value={bulkTo} onChange={setBulkTo} /></div>
          </div>
          <div>
            <Label>Status</Label>
            <Select value={bulkStatus} onValueChange={setBulkStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ATTENDANCE_STATUSES.map((s) => (<SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">Sundays will be skipped automatically.</p>
        </div>
      </FormModal>
    </div>
  );
}

interface BalanceRow { id: string; type: string; total: number; used: number }

function LeaveTab({ employeeId }: { employeeId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const year = new Date().getFullYear();

  const { data: balRes } = useQuery({
    queryKey: ["leave-balances", employeeId, year],
    queryFn: () => apiFetch<{ success: boolean; data: BalanceRow[] }>(`/employees/${employeeId}/leave-balances?year=${year}`),
  });
  const balances = balRes?.data || [];

  const { data: leavesRes } = useGetLeaves({ employeeId }, { query: { queryKey: getGetLeavesQueryKey({ employeeId }) } });
  const leaves = leavesRes?.data || [];

  const createLeave = useCreateLeave();
  const updateLeave = useUpdateLeave();

  const [applyOpen, setApplyOpen] = React.useState(false);
  const aForm = useForm({
    defaultValues: { type: "CL", fromDate: "", toDate: "", reason: "" },
    resolver: zodResolver(z.object({
      type: z.string().min(1),
      fromDate: z.string().min(1, "Required"),
      toDate: z.string().min(1, "Required"),
      reason: z.string().min(1, "Required"),
    })),
  });

  React.useEffect(() => { if (applyOpen) aForm.reset(); /* eslint-disable-next-line */ }, [applyOpen]);

  const submitApply = aForm.handleSubmit(async (v) => {
    try {
      const days = workingDaysBetween(v.fromDate, v.toDate);
      if (days <= 0) { toast({ title: "Invalid date range" }); return; }
      await createLeave.mutateAsync({
        data: { employeeId, type: v.type, fromDate: v.fromDate, toDate: v.toDate, days, reason: v.reason },
      });
      toast({ title: "Leave applied" });
      qc.invalidateQueries({ queryKey: getGetLeavesQueryKey({ employeeId }) });
      setApplyOpen(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  });

  const action = async (id: string, status: string) => {
    try {
      await updateLeave.mutateAsync({ id, data: { status } });
      toast({ title: `Leave ${status.toLowerCase()}` });
      qc.invalidateQueries({ queryKey: getGetLeavesQueryKey({ employeeId }) });
      qc.invalidateQueries({ queryKey: ["leave-balances", employeeId, year] });
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  };

  const fromDate = aForm.watch("fromDate");
  const toDate = aForm.watch("toDate");
  const computedDays = workingDaysBetween(fromDate, toDate);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="font-display text-lg font-semibold text-primary">Leave Balances ({year})</h3>
        <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => setApplyOpen(true)} data-testid="button-apply-leave">
          <Plus className="w-4 h-4 mr-2" /> Apply Leave
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {["CL", "SL", "EL", "PL"].map((t) => {
          const b = balances.find((x) => x.type === t);
          const used = b?.used || 0;
          const total = b?.total || 0;
          const remaining = total - used;
          return (
            <Card key={t} className="shadow-sm">
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">{t}</p>
                <p className="text-2xl font-display font-bold text-primary">{remaining}<span className="text-sm text-muted-foreground font-normal">/{total}</span></p>
                <p className="text-xs text-muted-foreground mt-1">{used} used</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="shadow-sm">
        <CardContent className="p-0">
          <BoundedScroll size="md">
          <table className="w-full text-sm">
            <thead className="bg-card border-b sticky top-0 z-10">
              <tr>
                <th className="p-3 text-left font-medium text-xs uppercase tracking-wider text-muted-foreground">Type</th>
                <th className="p-3 text-left font-medium text-xs uppercase tracking-wider text-muted-foreground">Duration</th>
                <th className="p-3 text-left font-medium text-xs uppercase tracking-wider text-muted-foreground">Reason</th>
                <th className="p-3 text-left font-medium text-xs uppercase tracking-wider text-muted-foreground">Status</th>
                <th className="p-3 text-right font-medium text-xs uppercase tracking-wider text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {leaves.length === 0 ? (
                <tr><td colSpan={5} className="p-8 text-center text-muted-foreground">No leave applications</td></tr>
              ) : leaves.map((l) => (
                <tr key={l.id} className="border-b hover:bg-muted/20">
                  <td className="p-3"><Badge variant="outline">{l.type}</Badge></td>
                  <td className="p-3">
                    <div className="text-sm">{new Date(l.fromDate).toLocaleDateString()} – {new Date(l.toDate).toLocaleDateString()}</div>
                    <div className="text-xs text-muted-foreground">{l.days} day(s)</div>
                  </td>
                  <td className="p-3 max-w-xs truncate" title={l.reason}>{l.reason}</td>
                  <td className="p-3"><StatusBadge status={l.status} /></td>
                  <td className="p-3 text-right">
                    {l.status === "PENDING" && (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" className="text-success border-success/20 hover:bg-success/10" onClick={() => action(l.id, "APPROVED")} disabled={updateLeave.isPending}>
                          <Check className="w-4 h-4" />
                        </Button>
                        <Button size="sm" variant="outline" className="text-destructive border-destructive/20 hover:bg-destructive/10" onClick={() => action(l.id, "REJECTED")} disabled={updateLeave.isPending}>
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </BoundedScroll>
        </CardContent>
      </Card>

      <FormModal
        open={applyOpen}
        onOpenChange={setApplyOpen}
        title="Apply Leave"
        onSave={submitApply}
        isSaving={createLeave.isPending}
        saveLabel="Submit"
      >
        <div className="space-y-4">
          <div>
            <Label>Type *</Label>
            <Select value={aForm.watch("type")} onValueChange={(v) => aForm.setValue("type", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {LEAVE_TYPES.map((t) => (<SelectItem key={t} value={t}>{t}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>From *</Label>
              <ControlledDatePicker control={aForm.control} name="fromDate" />
              {aForm.formState.errors.fromDate && <p className="text-xs text-destructive mt-1">{aForm.formState.errors.fromDate.message as string}</p>}
            </div>
            <div>
              <Label>To *</Label>
              <ControlledDatePicker control={aForm.control} name="toDate" />
              {aForm.formState.errors.toDate && <p className="text-xs text-destructive mt-1">{aForm.formState.errors.toDate.message as string}</p>}
            </div>
          </div>
          <div className="text-xs text-muted-foreground">Working days (excl. Sundays): <span className="font-medium text-primary">{computedDays}</span></div>
          <div>
            <Label>Reason *</Label>
            <Textarea rows={3} {...aForm.register("reason")} />
            {aForm.formState.errors.reason && <p className="text-xs text-destructive mt-1">{aForm.formState.errors.reason.message as string}</p>}
          </div>
        </div>
      </FormModal>
    </div>
  );
}

interface PerfNote { id: string; type: string; text: string; date: string; addedBy?: string | null }

function PerformanceTab({ employeeId }: { employeeId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: notesRes, isLoading } = useQuery({
    queryKey: ["emp-performance", employeeId],
    queryFn: () => apiFetch<{ success: boolean; data: PerfNote[] }>(`/employees/${employeeId}/performance`),
  });
  const notes = notesRes?.data || [];

  const [addOpen, setAddOpen] = React.useState(false);
  const [type, setType] = React.useState("APPRECIATION");
  const [text, setText] = React.useState("");
  const [date, setDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (addOpen) {
      setType("APPRECIATION"); setText(""); setDate(new Date().toISOString().slice(0, 10));
    }
  }, [addOpen]);

  const submit = async () => {
    if (!text.trim()) { toast({ title: "Note text required" }); return; }
    try {
      setSaving(true);
      await apiFetch(`/employees/${employeeId}/performance`, {
        method: "POST",
        body: JSON.stringify({ type, text, date }),
      });
      toast({ title: "Note added" });
      qc.invalidateQueries({ queryKey: ["emp-performance", employeeId] });
      setAddOpen(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const typeMeta = (t: string) => {
    if (t === "APPRECIATION") return { icon: Award, cls: "bg-success/20 text-success border-success/30" };
    if (t === "WARNING") return { icon: AlertTriangle, cls: "bg-destructive/20 text-destructive border-destructive/30" };
    return { icon: MessageSquare, cls: "bg-muted text-muted-foreground border-border" };
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="font-display text-lg font-semibold text-primary">Performance Notes</h3>
        <Button className="bg-accent hover:bg-accent/90 text-white" onClick={() => setAddOpen(true)} data-testid="button-add-note">
          <Plus className="w-4 h-4 mr-2" /> Add Note
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : notes.length === 0 ? (
        <Card className="shadow-sm">
          <CardContent className="p-12 text-center text-muted-foreground">
            <MessageSquare className="w-10 h-10 mx-auto text-muted/30 mb-2" />
            <p>No performance notes yet</p>
          </CardContent>
        </Card>
      ) : (
        <BoundedScroll size="lg" className="pr-2">
        <div className="relative pl-6 border-l-2 border-border space-y-4">
          {notes.map((n) => {
            const m = typeMeta(n.type);
            const Icon = m.icon;
            return (
              <div key={n.id} className="relative">
                <div className="absolute -left-[31px] w-4 h-4 rounded-full bg-card border-2 border-accent" />
                <Card className="shadow-sm">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <Badge variant="outline" className={`${m.cls} gap-1 text-[10px] uppercase tracking-wider`}>
                        <Icon className="w-3 h-3" /> {n.type}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{new Date(n.date).toLocaleDateString()}</span>
                    </div>
                    <p className="text-sm text-primary">{n.text}</p>
                  </CardContent>
                </Card>
              </div>
            );
          })}
        </div>
        </BoundedScroll>
      )}

      <FormModal open={addOpen} onOpenChange={setAddOpen} title="Add Performance Note" onSave={submit} isSaving={saving}>
        <div className="space-y-4">
          <div>
            <Label>Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="APPRECIATION">Appreciation</SelectItem>
                <SelectItem value="WARNING">Warning</SelectItem>
                <SelectItem value="NEUTRAL">Neutral</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Date</Label>
            <DatePicker value={date} onChange={setDate} />
          </div>
          <div>
            <Label>Text *</Label>
            <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
        </div>
      </FormModal>
    </div>
  );
}

interface ExitData {
  id: string;
  exitType: string;
  exitDate: string;
  reason?: string | null;
  status: string;
  finalSettlement?: number | null;
  clearances: Array<{ id: string; department: string; status: string }>;
  assets: Array<{ id: string; asset: string; returned: boolean }>;
}

function ExitTab({ employeeId }: { employeeId: string; onSwitchTab: (t: string) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: exitRes, isLoading } = useQuery({
    queryKey: ["emp-exit", employeeId],
    queryFn: () => apiFetch<{ success: boolean; data: ExitData | null }>(`/employees/${employeeId}/exit`),
  });
  const exit = exitRes?.data;
  const [settlement, setSettlement] = React.useState<string>("");

  React.useEffect(() => {
    if (exit?.finalSettlement != null) setSettlement(String(exit.finalSettlement));
  }, [exit?.finalSettlement]);

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (!exit) {
    return (
      <Card className="shadow-sm">
        <CardContent className="p-12 text-center text-muted-foreground">
          <LogOut className="w-12 h-12 mx-auto text-muted/30 mb-3" />
          <p className="font-medium">No exit initiated</p>
          <p className="text-sm mt-1">Use the "Initiate Exit" button at the top to start the offboarding process.</p>
        </CardContent>
      </Card>
    );
  }

  const markCleared = async (cid: string) => {
    try {
      await apiFetch(`/employees/exit-clearances/${cid}`, {
        method: "PUT", body: JSON.stringify({ status: "CLEARED" }),
      });
      qc.invalidateQueries({ queryKey: ["emp-exit", employeeId] });
    } catch (e: any) { toast({ title: e?.message || "Failed", variant: "destructive" }); }
  };

  const toggleAsset = async (aid: string, returned: boolean) => {
    try {
      await apiFetch(`/employees/exit-assets/${aid}`, {
        method: "PUT", body: JSON.stringify({ returned }),
      });
      qc.invalidateQueries({ queryKey: ["emp-exit", employeeId] });
    } catch (e: any) { toast({ title: e?.message || "Failed", variant: "destructive" }); }
  };

  const finalize = async () => {
    if (!settlement) { toast({ title: "Enter final settlement" }); return; }
    try {
      await apiFetch(`/employees/exits/${exit.id}/finalize`, {
        method: "POST", body: JSON.stringify({ finalSettlement: Number(settlement) }),
      });
      toast({ title: "Exit finalized" });
      qc.invalidateQueries({ queryKey: ["emp-exit", employeeId] });
      qc.invalidateQueries({ queryKey: getGetEmployeeQueryKey(employeeId) });
    } catch (e: any) { toast({ title: e?.message || "Failed", variant: "destructive" }); }
  };

  const allCleared = exit.clearances.every((c) => c.status === "CLEARED");

  return (
    <div className="space-y-4">
      <Card className="shadow-sm">
        <CardContent className="p-5">
          <div className="flex justify-between items-start gap-4">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Exit Summary</p>
              <p className="font-display text-lg font-semibold text-primary">{exit.exitType}</p>
              <p className="text-sm text-muted-foreground mt-0.5">Date: {new Date(exit.exitDate).toLocaleDateString()}</p>
              {exit.reason && <p className="text-sm mt-2">{exit.reason}</p>}
            </div>
            <StatusBadge status={exit.status} />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="shadow-sm">
          <CardContent className="p-5">
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Clearance Checklist</p>
            <BoundedScroll size="md" className="pr-2">
              <div className="space-y-2">
                {exit.clearances.map((c) => (
                  <div key={c.id} className="flex items-center justify-between border rounded-lg p-3">
                    <div className="flex items-center gap-3">
                      <span className="font-medium">{c.department}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    {c.status === "PENDING" && (
                      <Button size="sm" variant="outline" onClick={() => markCleared(c.id)}>Mark Cleared</Button>
                    )}
                  </div>
                ))}
              </div>
            </BoundedScroll>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardContent className="p-5">
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Asset Return</p>
            <BoundedScroll size="md" className="pr-2">
              <div className="space-y-2">
                {exit.assets.map((a) => (
                  <div key={a.id} className="flex items-center justify-between border rounded-lg p-3">
                    <div className="flex items-center gap-3">
                      <Checkbox checked={a.returned} onCheckedChange={(v) => toggleAsset(a.id, !!v)} />
                      <span className="font-medium">{a.asset.replace("_", " ")}</span>
                    </div>
                    {a.returned && <Badge variant="outline" className="text-success border-success/30">Returned</Badge>}
                  </div>
                ))}
              </div>
            </BoundedScroll>
          </CardContent>
        </Card>
      </div>

      {exit.status !== "COMPLETED" && (
        <Card className="shadow-sm">
          <CardContent className="p-5">
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Final Settlement</p>
            <div className="flex gap-3">
              <Input type="number" value={settlement} onChange={(e) => setSettlement(e.target.value)} placeholder="Amount in INR" />
              <Button className="bg-accent hover:bg-accent/90 text-white" onClick={finalize} disabled={!allCleared}>
                Finalize Exit
              </Button>
            </div>
            {!allCleared && <p className="text-xs text-warning mt-2">All clearances must be marked cleared before finalizing.</p>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ExitInitiateModal({
  open, onOpenChange, employeeId, onCreated,
}: { open: boolean; onOpenChange: (o: boolean) => void; employeeId: string; onCreated: () => void }) {
  const { toast } = useToast();
  const [exitType, setExitType] = React.useState("Resignation");
  const [exitDate, setExitDate] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) { setExitType("Resignation"); setExitDate(""); setReason(""); }
  }, [open]);

  const submit = async () => {
    if (!exitDate) { toast({ title: "Exit date required" }); return; }
    try {
      setSaving(true);
      await apiFetch(`/employees/${employeeId}/exit`, {
        method: "POST",
        body: JSON.stringify({ exitType, exitDate, reason }),
      });
      onOpenChange(false);
      onCreated();
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <FormModal open={open} onOpenChange={onOpenChange} title="Initiate Exit" onSave={submit} isSaving={saving} saveLabel="Initiate">
      <div className="space-y-4">
        <div>
          <Label>Exit Type</Label>
          <Select value={exitType} onValueChange={setExitType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="Resignation">Resignation</SelectItem>
              <SelectItem value="Termination">Termination</SelectItem>
              <SelectItem value="Contract End">Contract End</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Exit Date *</Label>
          <DatePicker value={exitDate} onChange={setExitDate} />
        </div>
        <div>
          <Label>Reason</Label>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
    </FormModal>
  );
}
