import * as React from "react";
import {
  useGetResident,
  getGetResidentQueryKey,
  useGetResidentLedger,
  getGetResidentLedgerQueryKey,
  useGetResidentPayments,
  getGetResidentPaymentsQueryKey,
  useGetComplaints,
  getGetComplaintsQueryKey,
  useCreateLedgerEntry,
  useCreatePayment,
  type LedgerEntryDto,
  type PaymentDto,
  type ReminderRuleDto,
  type ReminderLogDto,
} from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";
import { format } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/ui/user-avatar";
import { FormModal } from "@/components/ui/form-modal";
import { DataTable } from "@/components/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronLeft,
  Phone,
  Mail,
  MessageSquare,
  Receipt,
  AlertCircle,
  LogOut,
  Plus,
  FileText,
  Download,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ResidentKycTab } from "./resident-kyc-tab";
import { ResidentEsignTab } from "./resident-esign-tab";
import { CheckoutModal } from "@/components/checkout-modal";
import jsPDF from "jspdf";
import { BellRing, RefreshCw, ArrowUpCircle } from "lucide-react";

const LEDGER_TYPES = ["RENT", "UTILITY", "FOOD", "LAUNDRY", "PENALTY", "ADJUSTMENT", "DEPOSIT", "INCENTIVE"];
const PAYMENT_MODES = ["CASH", "UPI", "BANK_TRANSFER", "CARD", "CHEQUE"];

function ResidentAttendanceHistory({ residentId }: { residentId: string }) {
  const { data, isLoading } = useQuery<{ data: Array<{ id: string; attendanceDate: string; status: string; notes?: string | null }> }>({
    queryKey: ["resident-attendance-history", residentId],
    queryFn: () => apiFetch(`/resident-attendance/history/${residentId}`),
  });
  const records = data?.data || [];
  const summary = records.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {} as Record<string, number>);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Present</div><div className="text-2xl font-display font-bold">{summary.PRESENT || 0}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Absent</div><div className="text-2xl font-display font-bold">{summary.ABSENT || 0}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Out-pass</div><div className="text-2xl font-display font-bold">{summary.OUT_PASS || 0}</div></CardContent></Card>
      </div>
      <Card><CardContent className="p-0">
        {isLoading ? <div className="p-6"><Skeleton className="h-24" /></div> : records.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">No attendance records yet.</div>
        ) : (
          <Table>
            <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Status</TableHead><TableHead>Notes</TableHead></TableRow></TableHeader>
            <TableBody>
              {records.map((r) => (
                <TableRow key={r.id} data-testid={`history-row-${r.id}`}>
                  <TableCell className="text-xs">{format(new Date(r.attendanceDate), "dd MMM yyyy")}</TableCell>
                  <TableCell><Badge variant={r.status === "PRESENT" ? "default" : r.status === "ABSENT" ? "destructive" : "secondary"}>{r.status}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.notes || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent></Card>
    </div>
  );
}

export default function ResidentDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id as string;
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: residentRes, isLoading: residentLoading } = useGetResident(id, {
    query: { queryKey: getGetResidentQueryKey(id), enabled: !!id },
  });
  const { data: ledgerRes } = useGetResidentLedger(id, {
    query: { queryKey: getGetResidentLedgerQueryKey(id), enabled: !!id },
  });
  const { data: paymentsRes } = useGetResidentPayments(id, {
    query: { queryKey: getGetResidentPaymentsQueryKey(id), enabled: !!id },
  });
  const { data: complaintsRes } = useGetComplaints(
    {},
    { query: { queryKey: getGetComplaintsQueryKey({}), enabled: !!id } }
  );
  const { data: reminderCountRes } = useQuery<{ data: { count: number } }>({
    queryKey: ["resident-reminder-count", id],
    queryFn: () => apiFetch(`/residents/${id}/reminder-count`),
    enabled: !!id,
  });
  const reminderCount = reminderCountRes?.data?.count ?? 0;

  const resident = residentRes?.data;
  const ledger = ledgerRes?.data || [];
  const payments = paymentsRes?.data || [];
  const complaints = (complaintsRes?.data || []).filter((c) => c.residentId === id);

  const [ledgerModalOpen, setLedgerModalOpen] = React.useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = React.useState(false);
  const [checkoutOpen, setCheckoutOpen] = React.useState(false);

  if (residentLoading) {
    return <div className="space-y-6"><Skeleton className="h-48 w-full" /><Skeleton className="h-96 w-full" /></div>;
  }
  if (!resident) return <div>Resident not found</div>;

  const sortedLedger = [...ledger].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  let running = 0;
  const ledgerWithBalance = sortedLedger.map((e) => {
    const isCredit = e.amount < 0 || e.isPaid || e.type === "INCENTIVE" || e.type === "DEPOSIT";
    const debit = !isCredit ? Math.abs(e.amount) : 0;
    const credit = isCredit ? Math.abs(e.amount) : 0;
    running += debit - credit;
    return { ...e, debit, credit, balance: running };
  });
  const outstanding = ledger.filter((l) => !l.isPaid).reduce((s, l) => s + (l.amount || 0), 0);
  const totalPaid = payments.filter((p) => p.status === "SUCCESS").reduce((s, p) => s + (p.amount || 0), 0);

  const generateAgreement = () => {
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text("Tenancy Agreement", 20, 20);
    doc.setFontSize(11);
    let y = 40;
    [
      `Resident: ${resident.name}`,
      `Property: ${resident.propertyName || "—"}`,
      `Room: ${resident.roomNumber || "—"}`,
      `Check-in: ${resident.checkInDate || "—"}`,
      `Monthly Rent: Rs ${resident.monthlyRent || 0}`,
      `Security Deposit: Rs ${resident.securityDeposit || 0}`,
    ].forEach((line) => { doc.text(line, 20, y); y += 8; });
    window.open(doc.output("bloburl"), "_blank");
  };

  const generateReceipt = (p: PaymentDto) => {
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text("Payment Receipt", 20, 20);
    doc.setFontSize(11);
    let y = 40;
    [
      `Resident: ${resident.name}`,
      `Date: ${new Date(p.createdAt).toLocaleDateString()}`,
      `Amount: Rs ${p.amount.toLocaleString("en-IN")}`,
      `Mode: ${p.mode}`,
      `Reference: ${p.reference || "—"}`,
      `Status: ${p.status}`,
    ].forEach((line) => { doc.text(line, 20, y); y += 8; });
    window.open(doc.output("bloburl"), "_blank");
  };

  return (
    <div className="space-y-6">
      <Link href="/residents">
        <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" data-testid="link-back-residents">
          <ChevronLeft className="w-4 h-4 mr-1" /> Back to Residents
        </Button>
      </Link>

      <div className="flex justify-between items-start gap-4">
        <div className="flex items-center gap-4">
          <UserAvatar name={resident.name} src={resident.photo || undefined} className="h-20 w-20" fallbackClassName="text-2xl" />
          <div>
            <h1 className="text-2xl font-display font-bold tracking-tight text-primary">{resident.name}</h1>
            <div className="flex flex-wrap gap-2 mt-2">
              {resident.propertyName && <Badge variant="secondary">{resident.propertyName}</Badge>}
              {resident.roomNumber && <Badge variant="outline">Room {resident.roomNumber}</Badge>}
              <StatusBadge status={resident.status} />
            </div>
            <div className="flex gap-3 mt-2 text-sm text-muted-foreground">
              <span className="flex items-center gap-1"><Phone className="w-3.5 h-3.5" /> {resident.phone}</span>
              <span className="flex items-center gap-1"><Mail className="w-3.5 h-3.5" /> {resident.email}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => toast({ title: "Coming soon" })} data-testid="button-send-message">
          <MessageSquare className="w-4 h-4 mr-2" /> Send Message
        </Button>
        <Button variant="outline" size="sm" onClick={() => setPaymentModalOpen(true)} data-testid="button-record-payment">
          <Receipt className="w-4 h-4 mr-2" /> Record Payment
        </Button>
        <Button variant="outline" size="sm" onClick={() => toast({ title: "Coming soon" })} data-testid="button-raise-complaint">
          <AlertCircle className="w-4 h-4 mr-2" /> Raise Complaint
        </Button>
        <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setCheckoutOpen(true)} data-testid="button-checkout">
          <LogOut className="w-4 h-4 mr-2" /> Check Out
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground uppercase">Outstanding Balance</p>
            <p className={`text-2xl font-display font-bold ${outstanding > 0 ? "text-destructive" : "text-primary"}`}>
              ₹{outstanding.toLocaleString("en-IN")}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground uppercase">Total Paid</p>
            <p className="text-2xl font-display font-bold text-success">₹{totalPaid.toLocaleString("en-IN")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground uppercase">Plan</p>
            <p className="text-2xl font-display font-bold text-primary">{resident.planType || "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground uppercase">Check-in Date</p>
            <p className="text-lg font-display font-bold text-primary mt-1">
              {resident.checkInDate ? new Date(resident.checkInDate).toLocaleDateString() : "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="profile">
        <TabsList className="bg-surface">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="ledger">Ledger</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="complaints">Complaints</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="kyc" data-testid="tab-kyc">KYC</TabsTrigger>
          <TabsTrigger value="esign" data-testid="tab-esign">E-sign</TabsTrigger>
          <TabsTrigger value="reminders" data-testid="tab-reminders">
            Reminders
            {reminderCount > 0 && (
              <Badge variant="secondary" className="ml-2 text-[10px] px-1.5" data-testid="badge-reminder-count">{reminderCount}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="attendance" data-testid="tab-attendance-history">Attendance</TabsTrigger>
          <TabsTrigger value="wallet" data-testid="tab-wallet">Wallet</TabsTrigger>
        </TabsList>
        <TabsContent value="attendance" className="mt-6">
          <ResidentAttendanceHistory residentId={id} />
        </TabsContent>

        <TabsContent value="profile" className="mt-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardContent className="p-4 space-y-2">
                <h3 className="font-display font-semibold text-primary mb-2">Personal Info</h3>
                <Field label="Name" value={resident.name} />
                <Field label="DOB" value={resident.dob} />
                <Field label="Gender" value={resident.gender} />
                <Field label="College" value={resident.college} />
                <Field label="Course" value={resident.course} />
                <Field label="Dietary" value={(resident.dietaryPref || []).join(", ")} />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 space-y-2">
                <h3 className="font-display font-semibold text-primary mb-2">Parent / Emergency</h3>
                <Field label="Parent Name" value={resident.parentName} />
                <Field label="Parent Phone" value={resident.parentPhone} />
              </CardContent>
            </Card>
            <Card className="md:col-span-2">
              <CardContent className="p-4 space-y-2">
                <h3 className="font-display font-semibold text-primary mb-2">Accommodation</h3>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Property" value={resident.propertyName} />
                  <Field label="Room" value={resident.roomNumber} />
                  <Field label="Plan" value={resident.planType} />
                  <Field label="Monthly Rent" value={resident.monthlyRent ? `₹${resident.monthlyRent.toLocaleString("en-IN")}` : null} />
                  <Field label="Security Deposit" value={resident.securityDeposit ? `₹${resident.securityDeposit.toLocaleString("en-IN")}` : null} />
                  <Field label="Check-in" value={resident.checkInDate} />
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="ledger" className="mt-6">
          <Card className={`mb-4 ${outstanding > 0 ? "bg-destructive/5 border-destructive/20" : "bg-success/5 border-success/20"}`}>
            <CardContent className="p-4 flex justify-between items-center">
              <div>
                <p className="text-xs text-muted-foreground uppercase">Outstanding Balance</p>
                <p className={`text-3xl font-display font-bold ${outstanding > 0 ? "text-destructive" : "text-success"}`}>
                  ₹{outstanding.toLocaleString("en-IN")}
                </p>
              </div>
              <Button onClick={() => setLedgerModalOpen(true)} className="bg-accent hover:bg-accent/90 text-white" data-testid="button-add-ledger">
                <Plus className="w-4 h-4 mr-2" /> Add Entry
              </Button>
            </CardContent>
          </Card>
          <div className="rounded-md border bg-card">
            <Table>
              <TableHeader className="bg-surface/50">
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledgerWithBalance.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No entries</TableCell></TableRow>
                ) : (
                  ledgerWithBalance.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{new Date(e.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell><Badge variant="secondary" className="text-xs">{e.type}</Badge></TableCell>
                      <TableCell>{e.description}</TableCell>
                      <TableCell className="text-right text-destructive font-mono">{e.debit ? `₹${e.debit.toLocaleString("en-IN")}` : "—"}</TableCell>
                      <TableCell className="text-right text-success font-mono">{e.credit ? `₹${e.credit.toLocaleString("en-IN")}` : "—"}</TableCell>
                      <TableCell className="text-right font-mono font-semibold">₹{e.balance.toLocaleString("en-IN")}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="payments" className="mt-6 space-y-4">
          <DataTable
            columns={[
              { accessorKey: "createdAt", header: "Date", cell: ({ row }: any) => new Date(row.original.createdAt).toLocaleDateString() },
              { accessorKey: "amount", header: "Amount", cell: ({ row }: any) => `₹${row.original.amount.toLocaleString("en-IN")}` },
              { accessorKey: "mode", header: "Mode", cell: ({ row }: any) => <Badge variant="secondary">{row.original.mode}</Badge> },
              { accessorKey: "status", header: "Status", cell: ({ row }: any) => <StatusBadge status={row.original.status} /> },
              { accessorKey: "reference", header: "Reference", cell: ({ row }: any) => <span className="font-mono text-xs">{row.original.reference || "—"}</span> },
              {
                id: "actions",
                header: "",
                cell: ({ row }: any) => (
                  <Button size="sm" variant="ghost" onClick={() => generateReceipt(row.original)} data-testid={`button-receipt-${row.original.id}`}>
                    <Download className="w-3.5 h-3.5 mr-1" /> Receipt
                  </Button>
                ),
              },
            ] as any}
            data={payments}
          />
          <Card>
            <CardContent className="p-4">
              <h3 className="font-display font-semibold text-primary mb-2">Generate Payment Link</h3>
              <div className="flex gap-2">
                <Input placeholder="Amount" type="number" />
                <Button variant="outline">Generate</Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Razorpay integration requires API keys. Contact admin.
              </p>
            </CardContent>
          </Card>
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

        <TabsContent value="documents" className="mt-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { name: "Aadhar", collected: false },
              { name: "College ID", collected: false },
              { name: "Photo ID", collected: false },
              { name: "Agreement", collected: false },
            ].map((doc) => (
              <Card key={doc.name}>
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <FileText className="w-5 h-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-primary">{doc.name}</p>
                      <p className="text-xs text-muted-foreground">{doc.collected ? "Collected" : "Missing"}</p>
                    </div>
                  </div>
                  <StatusBadge status={doc.collected ? "ACTIVE" : "PENDING"} />
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="mt-4">
            <Button onClick={generateAgreement} variant="outline" data-testid="button-generate-agreement">
              <FileText className="w-4 h-4 mr-2" /> Generate Agreement
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="kyc" className="mt-6">
          <ResidentKycTab residentId={id} />
        </TabsContent>

        <TabsContent value="esign" className="mt-6">
          <ResidentEsignTab residentId={id} residentName={resident.name} />
        </TabsContent>

        <TabsContent value="reminders" className="mt-6">
          <ResidentRemindersTab residentId={id} ledger={ledger} />
        </TabsContent>

        <TabsContent value="wallet" className="mt-6">
          <ResidentWalletTab residentId={id} />
        </TabsContent>
      </Tabs>

      <AddLedgerModal open={ledgerModalOpen} onOpenChange={setLedgerModalOpen} residentId={id} />
      <AddPaymentModal open={paymentModalOpen} onOpenChange={setPaymentModalOpen} residentId={id} />
      <CheckoutModal open={checkoutOpen} onOpenChange={setCheckoutOpen} resident={resident} ledger={ledger} />
    </div>
  );
}

function ResidentRemindersTab({ residentId, ledger }: { residentId: string; ledger: LedgerEntryDto[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: logsRes, isLoading } = useQuery<{ success: boolean; data: ReminderLogDto[] }>({
    queryKey: ["reminder-logs", residentId],
    queryFn: () => apiFetch(`/reminder-logs?residentId=${residentId}`),
  });
  const { data: rulesRes } = useQuery<{ success: boolean; data: ReminderRuleDto[] }>({
    queryKey: ["reminder-rules"],
    queryFn: () => apiFetch(`/reminder-rules`),
  });
  const logs = logsRes?.data || [];
  const rules = (rulesRes?.data || []).filter((r) => r.isActive);
  const unpaid = ledger.filter((l) => !l.isPaid);

  const [ruleId, setRuleId] = React.useState<string>("");
  const [entryId, setEntryId] = React.useState<string>("");

  const sendMut = useMutation({
    mutationFn: (body: { ruleId: string; ledgerEntryId: string }) =>
      apiFetch(`/reminders/send`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast({ title: "Reminder sent" });
      qc.invalidateQueries({ queryKey: ["reminder-logs", residentId] });
    },
    onError: (e: Error) => toast({ title: e?.message || "Failed", variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <BellRing className="w-4 h-4 text-accent" />
            <h3 className="font-display font-semibold text-primary">Send a reminder now</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <Label>Rule</Label>
              <Select value={ruleId} onValueChange={setRuleId}>
                <SelectTrigger data-testid="select-resident-reminder-rule"><SelectValue placeholder="Choose rule" /></SelectTrigger>
                <SelectContent>
                  {rules.map((r) => <SelectItem key={r.id} value={r.id}>{r.name} • {r.channel}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Ledger entry</Label>
              <Select value={entryId} onValueChange={setEntryId}>
                <SelectTrigger data-testid="select-resident-reminder-entry"><SelectValue placeholder="Choose unpaid entry" /></SelectTrigger>
                <SelectContent>
                  {unpaid.length === 0 && <SelectItem value="__none__" disabled>No unpaid entries</SelectItem>}
                  {unpaid.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      ₹{e.amount} • {e.description?.slice(0, 40) || e.type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button
                disabled={!ruleId || !entryId || sendMut.isPending}
                onClick={() => sendMut.mutate({ ruleId, ledgerEntryId: entryId })}
                className="bg-accent hover:bg-accent/90 text-white w-full"
                data-testid="button-send-resident-reminder"
              >
                <RefreshCw className="w-4 h-4 mr-2" /> Send / Resend
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <DataTable
        columns={[
          { accessorKey: "createdAt", header: "Sent At", cell: ({ row }: any) => format(new Date(row.original.createdAt), "dd MMM yyyy HH:mm") },
          { accessorKey: "ruleName", header: "Rule" },
          { accessorKey: "channel", header: "Channel", cell: ({ row }: any) => <Badge variant="outline">{row.original.channel}</Badge> },
          { accessorKey: "subject", header: "Subject", cell: ({ row }: any) => row.original.subject || "—" },
          { accessorKey: "status", header: "Status", cell: ({ row }: any) => <Badge variant={row.original.status === "SENT" ? "success" : "destructive"}>{row.original.status}</Badge> },
        ] as any}
        data={logs}
        isLoading={isLoading}
      />
    </div>
  );
}

function ResidentWalletTab({ residentId }: { residentId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: walletRes, isLoading } = useQuery<{
    success: boolean;
    data: { id: string; balance: number; isActive: boolean; walletEnabled: boolean; transactionCount: number };
  }>({
    queryKey: ["resident-wallet", residentId],
    queryFn: () => apiFetch(`/wallet/residents/${residentId}`),
    enabled: !!residentId,
  });

  const { data: txRes } = useQuery<{
    success: boolean;
    data: Array<{ id: string; type: string; amount: number; balanceBefore: number; balanceAfter: number; description: string; createdAt: string; notes?: string | null }>;
    meta: { total: number };
  }>({
    queryKey: ["resident-wallet-txns", residentId],
    queryFn: () => apiFetch(`/wallet/residents/${residentId}/transactions?limit=30`),
    enabled: !!residentId,
  });

  const wallet = walletRes?.data;
  const txns = txRes?.data || [];

  const [topupOpen, setTopupOpen] = React.useState(false);
  const [adjustOpen, setAdjustOpen] = React.useState(false);
  const [topupAmount, setTopupAmount] = React.useState("");
  const [topupDesc, setTopupDesc] = React.useState("Cash top-up by staff");
  const [topupNotes, setTopupNotes] = React.useState("");
  const [adjustAmount, setAdjustAmount] = React.useState("");
  const [adjustType, setAdjustType] = React.useState<"ADJUSTMENT_CREDIT" | "ADJUSTMENT_DEBIT">("ADJUSTMENT_CREDIT");
  const [adjustDesc, setAdjustDesc] = React.useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["resident-wallet", residentId] });
    qc.invalidateQueries({ queryKey: ["resident-wallet-txns", residentId] });
  };

  const topupMut = useMutation({
    mutationFn: (body: object) => apiFetch(`/wallet/residents/${residentId}/topup`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { toast({ title: "Top-up successful" }); invalidate(); setTopupOpen(false); setTopupAmount(""); setTopupNotes(""); },
    onError: (e: Error) => toast({ title: "Top-up failed", description: e.message, variant: "destructive" }),
  });

  const adjustMut = useMutation({
    mutationFn: (body: object) => apiFetch(`/wallet/residents/${residentId}/adjust`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { toast({ title: "Adjustment applied" }); invalidate(); setAdjustOpen(false); setAdjustAmount(""); setAdjustDesc(""); },
    onError: (e: Error) => toast({ title: "Adjustment failed", description: e.message, variant: "destructive" }),
  });

  function txTypeBadge(type: string) {
    const colorMap: Record<string, string> = {
      TOPUP: "text-green-700",
      ADJUSTMENT_CREDIT: "text-green-600",
      REFUND_WITHDRAWAL: "text-green-600",
      PAYMENT: "text-red-600",
      PARTIAL_PAYMENT: "text-orange-600",
      ADJUSTMENT_DEBIT: "text-red-500",
      REVERSAL: "text-purple-600",
    };
    return <Badge variant="outline" className={colorMap[type] || ""}>{type.replace(/_/g, " ")}</Badge>;
  }

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  const isCredit = (type: string) => ["TOPUP", "ADJUSTMENT_CREDIT", "REFUND_WITHDRAWAL"].includes(type);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-muted-foreground uppercase mb-1">Current Balance</div>
          <div className={`text-3xl font-display font-bold ${(wallet?.balance ?? 0) < 0 ? "text-destructive" : (wallet?.balance ?? 0) < 200 ? "text-yellow-600" : "text-green-600"}`}>
            ₹{(wallet?.balance ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          </div>
          {wallet && !wallet.walletEnabled && (
            <Badge variant="outline" className="text-muted-foreground mt-1">Wallet disabled for this resident</Badge>
          )}
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setTopupOpen(true)} disabled={!wallet?.walletEnabled}>
            <ArrowUpCircle className="w-3.5 h-3.5 mr-1" /> Top-up
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAdjustOpen(true)}>
            Adjust
          </Button>
          <Button size="sm" variant="ghost" onClick={invalidate}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {txns.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">No transactions yet</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Balance After</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {txns.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="text-xs">{format(new Date(t.createdAt), "dd MMM yy HH:mm")}</TableCell>
                    <TableCell>{txTypeBadge(t.type)}</TableCell>
                    <TableCell className="text-sm">{t.description}</TableCell>
                    <TableCell className={`text-right font-mono text-sm ${isCredit(t.type) ? "text-green-600" : "text-red-600"}`}>
                      {isCredit(t.type) ? "+" : "−"}₹{t.amount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      ₹{t.balanceAfter.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <FormModal open={topupOpen} onClose={() => setTopupOpen(false)} title="Top-up Wallet" onSubmit={() => {
        const amt = parseFloat(topupAmount);
        if (isNaN(amt) || amt <= 0) { toast({ title: "Enter a valid amount", variant: "destructive" }); return; }
        topupMut.mutate({ amount: amt, description: topupDesc, notes: topupNotes });
      }} isLoading={topupMut.isPending}>
        <div className="space-y-3">
          <div><Label>Amount (₹)</Label><Input type="number" min="1" value={topupAmount} onChange={(e) => setTopupAmount(e.target.value)} placeholder="500" /></div>
          <div><Label>Description</Label><Input value={topupDesc} onChange={(e) => setTopupDesc(e.target.value)} /></div>
          <div><Label>Notes (optional)</Label><Textarea rows={2} value={topupNotes} onChange={(e) => setTopupNotes(e.target.value)} /></div>
        </div>
      </FormModal>

      <FormModal open={adjustOpen} onClose={() => setAdjustOpen(false)} title="Manual Adjustment" onSubmit={() => {
        const amt = parseFloat(adjustAmount);
        if (isNaN(amt) || amt <= 0) { toast({ title: "Enter a valid amount", variant: "destructive" }); return; }
        if (!adjustDesc) { toast({ title: "Description required", variant: "destructive" }); return; }
        adjustMut.mutate({ type: adjustType, amount: amt, description: adjustDesc });
      }} isLoading={adjustMut.isPending}>
        <div className="space-y-3">
          <div>
            <Label>Type</Label>
            <Select value={adjustType} onValueChange={(v) => setAdjustType(v as typeof adjustType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ADJUSTMENT_CREDIT">Credit (add funds)</SelectItem>
                <SelectItem value="ADJUSTMENT_DEBIT">Debit (remove funds)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label>Amount (₹)</Label><Input type="number" min="1" value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} /></div>
          <div><Label>Reason / Description</Label><Input value={adjustDesc} onChange={(e) => setAdjustDesc(e.target.value)} placeholder="Correction for..." /></div>
        </div>
      </FormModal>
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground uppercase">{label}</p>
      <p className="text-sm text-primary font-medium">{value || "—"}</p>
    </div>
  );
}

function AddLedgerModal({ open, onOpenChange, residentId }: { open: boolean; onOpenChange: (o: boolean) => void; residentId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const mut = useCreateLedgerEntry();
  const [type, setType] = React.useState("RENT");
  const [amount, setAmount] = React.useState(0);
  const [description, setDescription] = React.useState("");
  const [dueDate, setDueDate] = React.useState("");

  React.useEffect(() => {
    if (open) { setType("RENT"); setAmount(0); setDescription(""); setDueDate(""); }
  }, [open]);

  const onSave = async () => {
    try {
      await mut.mutateAsync({ id: residentId, data: { type, amount: Number(amount), description, dueDate: dueDate || undefined } });
      toast({ title: "Entry added" });
      qc.invalidateQueries({ queryKey: getGetResidentLedgerQueryKey(residentId) });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  };

  return (
    <FormModal open={open} onOpenChange={onOpenChange} title="Add Ledger Entry" onSave={onSave} isSaving={mut.isPending} saveLabel="Add Entry">
      <div className="space-y-4">
        <div>
          <Label>Type *</Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {LEDGER_TYPES.map((t) => (<SelectItem key={t} value={t}>{t}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Amount (₹) *</Label>
          <Input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} data-testid="input-ledger-amount" />
        </div>
        <div>
          <Label>Description *</Label>
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <Label>Due Date</Label>
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      </div>
    </FormModal>
  );
}

function AddPaymentModal({ open, onOpenChange, residentId }: { open: boolean; onOpenChange: (o: boolean) => void; residentId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const mut = useCreatePayment();
  const [amount, setAmount] = React.useState(0);
  const [mode, setMode] = React.useState("CASH");
  const [reference, setReference] = React.useState("");
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (open) { setAmount(0); setMode("CASH"); setReference(""); setNotes(""); }
  }, [open]);

  const onSave = async () => {
    try {
      await mut.mutateAsync({ id: residentId, data: { amount: Number(amount), mode, reference: reference || undefined, notes: notes || undefined } });
      toast({ title: "Payment recorded" });
      qc.invalidateQueries({ queryKey: getGetResidentPaymentsQueryKey(residentId) });
      qc.invalidateQueries({ queryKey: getGetResidentLedgerQueryKey(residentId) });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  };

  return (
    <FormModal open={open} onOpenChange={onOpenChange} title="Record Payment" onSave={onSave} isSaving={mut.isPending} saveLabel="Record Payment">
      <div className="space-y-4">
        <div>
          <Label>Amount (₹) *</Label>
          <Input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} data-testid="input-payment-amount" />
        </div>
        <div>
          <Label>Mode *</Label>
          <Select value={mode} onValueChange={setMode}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {PAYMENT_MODES.map((m) => (<SelectItem key={m} value={m}>{m}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Reference</Label>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        <div>
          <Label>Notes</Label>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
    </FormModal>
  );
}
