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
  useCreateComplaint,
  useCreateLedgerEntry,
  useCreatePayment,
  type LedgerEntryDto,
  type PaymentDto,
  type ReminderRuleDto,
  type ReminderLogDto,
  type ResidentDto,
} from "@workspace/api-client-react";
import { useParams, Link, useLocation } from "wouter";
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
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/ui/user-avatar";
import { FormModal } from "@/components/ui/form-modal";
import { DataTable } from "@/components/data-table";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Phone,
  Mail,
  MessageSquare,
  Receipt,
  AlertCircle,
  LogOut,
  Plus,
  FileText,
  Download,
  Megaphone,
  HandCoins,
  Link2,
  Copy,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ResidentKycTab } from "./resident-kyc-tab";
import { ResidentEsignTab, RentAgreementBanner, type EsignRow } from "./resident-esign-tab";
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
          <BoundedScroll size="md">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card"><TableRow><TableHead>Date</TableHead><TableHead>Status</TableHead><TableHead>Notes</TableHead></TableRow></TableHeader>
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
          </BoundedScroll>
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

  // O25 — surface the rent-agreement gate. The most recent non-voided
  // 'Rent Agreement' esign request drives the signed/required indicator.
  const { data: esignRes } = useQuery<{ data: EsignRow[] }>({
    queryKey: ["esign", id],
    queryFn: () => apiFetch(`/residents/${id}/esign`),
    enabled: !!id,
  });
  const rentAgreement = (esignRes?.data || [])
    .filter((r) => r.documentName === "Rent Agreement" && r.status !== "VOIDED")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  const agreementSigned = rentAgreement?.status === "SIGNED";

  const resident = residentRes?.data;
  const ledger = ledgerRes?.data || [];
  const payments = paymentsRes?.data || [];
  const complaints = (complaintsRes?.data || []).filter((c) => c.residentId === id);

  const [ledgerModalOpen, setLedgerModalOpen] = React.useState(false);
  const [collectionModalOpen, setCollectionModalOpen] = React.useState(false);
  const [paymentLinkModalOpen, setPaymentLinkModalOpen] = React.useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = React.useState(false);
  const [checkoutOpen, setCheckoutOpen] = React.useState(false);
  const [messageModalOpen, setMessageModalOpen] = React.useState(false);
  const [complaintModalOpen, setComplaintModalOpen] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState("profile");

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

      <div className="flex justify-between items-start gap-4">
        <div className="flex items-center gap-4">
          <UserAvatar name={resident.name} src={resident.photo || undefined} className="h-20 w-20" fallbackClassName="text-2xl" />
          <div>
            <h1 className="text-2xl font-display font-bold tracking-tight text-primary">{resident.name}</h1>
            <div className="flex flex-wrap gap-2 mt-2">
              {resident.propertyName && <Badge variant="secondary">{resident.propertyName}</Badge>}
              {resident.roomNumber && <Badge variant="outline">Room {resident.roomNumber}</Badge>}
              <StatusBadge status={resident.status} />
              <Badge
                variant={agreementSigned ? "success" : "warning"}
                data-testid="badge-agreement-status"
              >
                {agreementSigned ? "Agreement: signed" : "Agreement: required"}
              </Badge>
            </div>
            <div className="flex gap-3 mt-2 text-sm text-muted-foreground">
              <span className="flex items-center gap-1"><Phone className="w-3.5 h-3.5" /> {resident.phone}</span>
              <span className="flex items-center gap-1"><Mail className="w-3.5 h-3.5" /> {resident.email}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setMessageModalOpen(true)} data-testid="button-send-message">
          <MessageSquare className="w-4 h-4 mr-2" /> Send Message
        </Button>
        <Button variant="outline" size="sm" onClick={() => setPaymentModalOpen(true)} data-testid="button-record-payment">
          <Receipt className="w-4 h-4 mr-2" /> Record Payment
        </Button>
        <Button variant="outline" size="sm" onClick={() => setCollectionModalOpen(true)} data-testid="button-record-collection">
          <HandCoins className="w-4 h-4 mr-2" /> Record Collection
        </Button>
        <Button variant="outline" size="sm" onClick={() => setPaymentLinkModalOpen(true)} data-testid="button-share-payment-link">
          <Link2 className="w-4 h-4 mr-2" /> Share Payment Link
        </Button>
        <Button variant="outline" size="sm" onClick={() => setComplaintModalOpen(true)} data-testid="button-raise-complaint">
          <AlertCircle className="w-4 h-4 mr-2" /> Raise Complaint
        </Button>
        <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setCheckoutOpen(true)} data-testid="button-checkout">
          <LogOut className="w-4 h-4 mr-2" /> Check Out
        </Button>
      </div>

      {resident.status !== "ACTIVE" && !agreementSigned && (
        <Card className="bg-warning/5 border-warning/20" data-testid="agreement-activation-hint">
          <CardContent className="p-4 flex items-start gap-3">
            <FileText className="w-5 h-5 text-warning mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="font-medium text-primary">A signed rent agreement is required before activation</p>
              <p className="text-muted-foreground mt-0.5">
                {rentAgreement
                  ? "The rent agreement has been generated but not yet signed. Share the signing link from the E-sign tab, then activate the resident."
                  : "No rent agreement exists yet. Generate one from the E-sign tab and have the resident sign it before activating."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

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

      <Tabs value={activeTab} onValueChange={setActiveTab}>
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
            <BoundedScroll size="md">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-surface">
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
            </BoundedScroll>
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
            <RentAgreementBanner
              residentId={id}
              agreement={rentAgreement}
              onOpenDetail={() => setActiveTab("esign")}
            />
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
      <RecordCollectionModal open={collectionModalOpen} onOpenChange={setCollectionModalOpen} residentId={id} outstanding={outstanding} />
      <SharePaymentLinkModal open={paymentLinkModalOpen} onOpenChange={setPaymentLinkModalOpen} resident={resident} outstanding={outstanding} />
      <AddPaymentModal open={paymentModalOpen} onOpenChange={setPaymentModalOpen} residentId={id} />
      <CheckoutModal open={checkoutOpen} onOpenChange={setCheckoutOpen} resident={resident} ledger={ledger} />
      <SendMessageModal open={messageModalOpen} onOpenChange={setMessageModalOpen} resident={resident} />
      <RaiseComplaintModal open={complaintModalOpen} onOpenChange={setComplaintModalOpen} resident={resident} />
    </div>
  );
}

function SendMessageModal({ open, onOpenChange, resident }: { open: boolean; onOpenChange: (o: boolean) => void; resident: ResidentDto }) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [channel, setChannel] = React.useState<"EMAIL" | "SMS">("EMAIL");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");

  React.useEffect(() => {
    if (open) { setChannel(resident.email ? "EMAIL" : "SMS"); setSubject(""); setBody(""); }
  }, [open, resident.email]);

  const canSend = channel === "EMAIL" ? !!resident.email && !!body.trim() : !!resident.phone && !!body.trim();

  const send = () => {
    if (channel === "EMAIL") {
      if (!resident.email) { toast({ title: "No email on file for this resident", variant: "destructive" }); return; }
      const href = `mailto:${resident.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      window.location.href = href;
    } else {
      if (!resident.phone) { toast({ title: "No phone on file for this resident", variant: "destructive" }); return; }
      // sms: URI — opens the staff device's SMS composer pre-filled for this resident.
      const href = `sms:${resident.phone}?body=${encodeURIComponent(body)}`;
      window.location.href = href;
    }
    toast({ title: "Opening your messaging app", description: `Composing a ${channel === "EMAIL" ? "email" : "text"} to ${resident.name}.` });
    onOpenChange(false);
  };

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title={`Message ${resident.name}`}
      onSave={send}
      saveLabel={channel === "EMAIL" ? "Open Email" : "Open SMS"}
      isSaving={false}
    >
      <div className="space-y-4">
        <div className="flex gap-2">
          <Button type="button" size="sm" variant={channel === "EMAIL" ? "default" : "outline"} onClick={() => setChannel("EMAIL")} data-testid="message-channel-email" className="flex-1">
            <Mail className="w-4 h-4 mr-2" /> Email
          </Button>
          <Button type="button" size="sm" variant={channel === "SMS" ? "default" : "outline"} onClick={() => setChannel("SMS")} data-testid="message-channel-sms" className="flex-1">
            <MessageSquare className="w-4 h-4 mr-2" /> SMS
          </Button>
        </div>
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          {channel === "EMAIL"
            ? <><Mail className="w-3.5 h-3.5" /> {resident.email || "No email on file"}</>
            : <><Phone className="w-3.5 h-3.5" /> {resident.phone || "No phone on file"}</>}
        </p>
        {channel === "EMAIL" && (
          <div>
            <Label>Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Regarding your stay at Uniliv" data-testid="input-message-subject" />
          </div>
        )}
        <div>
          <Label>Message *</Label>
          <Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder={`Hi ${resident.name.split(" ")[0]}, ...`} data-testid="input-message-body" />
        </div>
        {!canSend && (
          <p className="text-xs text-muted-foreground">
            {channel === "EMAIL" && !resident.email ? "This resident has no email address on file." :
              channel === "SMS" && !resident.phone ? "This resident has no phone number on file." :
                "Enter a message to continue."}
          </p>
        )}
        <div className="border-t pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => { onOpenChange(false); setLocation("/communications"); }}
            data-testid="button-goto-bulk-comms"
          >
            <Megaphone className="w-4 h-4 mr-2" /> Send a templated bulk message instead
          </Button>
        </div>
      </div>
    </FormModal>
  );
}

const COMPLAINT_CATEGORIES = ["ELECTRICAL", "PLUMBING", "INTERNET", "HOUSEKEEPING", "SECURITY", "FOOD", "LAUNDRY", "OTHER"];
const COMPLAINT_SLA: Record<string, number> = {
  ELECTRICAL: 4, PLUMBING: 4, INTERNET: 2, HOUSEKEEPING: 8, SECURITY: 1, FOOD: 2, LAUNDRY: 24, OTHER: 24,
};

function RaiseComplaintModal({ open, onOpenChange, resident }: { open: boolean; onOpenChange: (o: boolean) => void; resident: ResidentDto }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const mut = useCreateComplaint();

  const [category, setCategory] = React.useState("OTHER");
  const [priority, setPriority] = React.useState("MEDIUM");
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");

  React.useEffect(() => {
    if (open) { setCategory("OTHER"); setPriority("MEDIUM"); setTitle(""); setDescription(""); }
  }, [open]);

  const slaHours = COMPLAINT_SLA[category] || 24;

  const onSave = async () => {
    if (!resident.propertyId) { toast({ title: "Resident has no property assigned", variant: "destructive" }); return; }
    if (!title.trim() || !description.trim()) { toast({ title: "Title and description are required", variant: "destructive" }); return; }
    try {
      await mut.mutateAsync({
        data: {
          propertyId: resident.propertyId,
          residentId: resident.id,
          category,
          priority,
          title,
          description,
          slaHours,
        },
      });
      toast({ title: "Complaint raised", description: `Logged for ${resident.name}.` });
      qc.invalidateQueries({ queryKey: getGetComplaintsQueryKey() });
      qc.invalidateQueries({ queryKey: getGetComplaintsQueryKey({}) });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed to raise complaint", variant: "destructive" });
    }
  };

  return (
    <FormModal open={open} onOpenChange={onOpenChange} title={`Raise Complaint for ${resident.name}`} onSave={onSave} isSaving={mut.isPending} saveLabel="Raise Complaint">
      <div className="space-y-4">
        <div className="rounded-md bg-surface p-3 text-sm">
          <span className="text-muted-foreground">For </span>
          <span className="font-medium text-primary">{resident.name}</span>
          {resident.propertyName && <span className="text-muted-foreground"> · {resident.propertyName}</span>}
          {resident.roomNumber && <span className="text-muted-foreground"> · Room {resident.roomNumber}</span>}
        </div>
        <div>
          <Label>Category *</Label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger data-testid="select-complaint-category"><SelectValue /></SelectTrigger>
            <SelectContent>
              {COMPLAINT_CATEGORIES.map((c) => (<SelectItem key={c} value={c}>{c}</SelectItem>))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">Expected SLA: {slaHours} hours</p>
        </div>
        <div>
          <Label>Priority *</Label>
          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="LOW">Low</SelectItem>
              <SelectItem value="MEDIUM">Medium</SelectItem>
              <SelectItem value="HIGH">High</SelectItem>
              <SelectItem value="CRITICAL">Critical</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Title *</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short summary of the issue" data-testid="input-complaint-title" />
        </div>
        <div>
          <Label>Description *</Label>
          <Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} data-testid="input-complaint-description" />
        </div>
      </div>
    </FormModal>
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
  const [, setLocation] = useLocation();
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
    queryFn: () => apiFetch(`/wallet/residents/${residentId}/transactions?limit=10`),
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
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" onClick={() => setTopupOpen(true)} disabled={!wallet?.walletEnabled}>
            <ArrowUpCircle className="w-3.5 h-3.5 mr-1" /> Top-up
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAdjustOpen(true)}>
            Adjust
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setLocation(`/wallet/${residentId}`)}>
            Full History →
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
            <BoundedScroll size="md">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
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
            </BoundedScroll>
          )}
        </CardContent>
      </Card>

      <FormModal open={topupOpen} onOpenChange={(o) => { if (!o) setTopupOpen(false); }} title="Top-up Wallet" onSave={() => {
        const amt = parseFloat(topupAmount);
        if (isNaN(amt) || amt <= 0) { toast({ title: "Enter a valid amount", variant: "destructive" }); return; }
        topupMut.mutate({ amount: amt, description: topupDesc, notes: topupNotes });
      }} isSaving={topupMut.isPending}>
        <div className="space-y-3">
          <div><Label>Amount (₹)</Label><Input type="number" min="1" value={topupAmount} onChange={(e) => setTopupAmount(e.target.value)} placeholder="500" /></div>
          <div><Label>Description</Label><Input value={topupDesc} onChange={(e) => setTopupDesc(e.target.value)} /></div>
          <div><Label>Notes (optional)</Label><Textarea rows={2} value={topupNotes} onChange={(e) => setTopupNotes(e.target.value)} /></div>
        </div>
      </FormModal>

      <FormModal open={adjustOpen} onOpenChange={(o) => { if (!o) setAdjustOpen(false); }} title="Manual Adjustment" onSave={() => {
        const amt = parseFloat(adjustAmount);
        if (isNaN(amt) || amt <= 0) { toast({ title: "Enter a valid amount", variant: "destructive" }); return; }
        if (!adjustDesc) { toast({ title: "Description required", variant: "destructive" }); return; }
        adjustMut.mutate({ type: adjustType, amount: amt, description: adjustDesc });
      }} isSaving={adjustMut.isPending}>
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
          <DatePicker value={dueDate} onChange={setDueDate} />
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

function todayIso(): string {
  return format(new Date(), "yyyy-MM-dd");
}

/**
 * O24 — Record a CREDIT/collection ledger entry. Posts in "collection mode" to
 * POST /residents/:id/ledger with entryType="CREDIT"; the backend inserts a paid
 * CREDIT row and auto-settles the oldest unpaid charges up to the amount.
 */
function RecordCollectionModal({ open, onOpenChange, residentId, outstanding }: { open: boolean; onOpenChange: (o: boolean) => void; residentId: string; outstanding: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [amount, setAmount] = React.useState("");
  const [collectionDate, setCollectionDate] = React.useState(todayIso());
  const [type, setType] = React.useState("ADJUSTMENT");
  const [description, setDescription] = React.useState("");
  const [reference, setReference] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setAmount(outstanding > 0 ? String(outstanding) : "");
      setCollectionDate(todayIso());
      setType("ADJUSTMENT");
      setDescription("");
      setReference("");
    }
  }, [open, outstanding]);

  const mut = useMutation({
    mutationFn: (body: object) =>
      apiFetch<{ success: boolean; data: { settledCount: number } }>(`/residents/${residentId}/ledger`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (res) => {
      const settled = res?.data?.settledCount ?? 0;
      toast({ title: "Collection recorded", description: settled > 0 ? `Settled ${settled} charge${settled === 1 ? "" : "s"}.` : undefined });
      qc.invalidateQueries({ queryKey: getGetResidentLedgerQueryKey(residentId) });
      qc.invalidateQueries({ queryKey: getGetResidentPaymentsQueryKey(residentId) });
      onOpenChange(false);
    },
    onError: (e: Error) => toast({ title: e?.message || "Failed to record collection", variant: "destructive" }),
  });

  const onSave = () => {
    const amt = Number(amount);
    if (isNaN(amt) || amt <= 0) { toast({ title: "Enter a valid amount", variant: "destructive" }); return; }
    mut.mutate({
      entryType: "CREDIT",
      amount: amt,
      collectionDate: collectionDate || undefined,
      type,
      description: description || undefined,
      reference: reference || undefined,
    });
  };

  return (
    <FormModal open={open} onOpenChange={onOpenChange} title="Record Collection" onSave={onSave} isSaving={mut.isPending} saveLabel="Record Collection">
      <div className="space-y-4">
        <div className="rounded-md bg-success/5 border border-success/20 p-3 text-sm">
          <span className="text-muted-foreground">A collection records money received from the resident and settles their oldest unpaid charges.</span>
          {outstanding > 0 && (
            <div className="mt-1 text-primary font-medium">Outstanding dues: ₹{outstanding.toLocaleString("en-IN")}</div>
          )}
        </div>
        <div>
          <Label>Amount (₹) *</Label>
          <Input type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="input-collection-amount" />
        </div>
        <div>
          <Label>Collection Date *</Label>
          <DatePicker value={collectionDate} onChange={setCollectionDate} max={todayIso()} data-testid="datepicker-collection-date" />
        </div>
        <div>
          <Label>Type</Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {LEDGER_TYPES.map((t) => (<SelectItem key={t} value={t}>{t}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Description</Label>
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <Label>Reference</Label>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / receipt no." />
        </div>
      </div>
    </FormModal>
  );
}

const PAYMENTS_NOT_CONFIGURED = "Payments not configured";
type LinkRecipient = "resident" | "guardian" | "custom";

/**
 * O23 — Generate & share a Razorpay payment link for the resident's dues. Posts to
 * POST /residents/:id/payment-link. Amount defaults to current outstanding dues.
 * A 503 ("Payments not configured") surfaces a friendly gateway-not-ready message.
 */
function SharePaymentLinkModal({ open, onOpenChange, resident, outstanding }: { open: boolean; onOpenChange: (o: boolean) => void; resident: ResidentDto; outstanding: number }) {
  const { toast } = useToast();
  const [recipient, setRecipient] = React.useState<LinkRecipient>("resident");
  const [amount, setAmount] = React.useState("");
  const [custom, setCustom] = React.useState("");
  const [shortUrl, setShortUrl] = React.useState<string | null>(null);
  const [notConfigured, setNotConfigured] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setRecipient("resident");
      setAmount(outstanding > 0 ? String(outstanding) : "");
      setCustom("");
      setShortUrl(null);
      setNotConfigured(false);
    }
  }, [open, outstanding]);

  const mut = useMutation({
    mutationFn: (body: object) =>
      apiFetch<{ success: boolean; data: { shortUrl: string; id: string } }>(`/residents/${resident.id}/payment-link`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (res) => {
      setShortUrl(res?.data?.shortUrl ?? null);
      toast({ title: "Payment link sent", description: "Shared with the selected recipient." });
    },
    onError: (e: Error) => {
      if (e?.message === PAYMENTS_NOT_CONFIGURED) {
        setNotConfigured(true);
        return;
      }
      toast({ title: e?.message || "Failed to create payment link", variant: "destructive" });
    },
  });

  const onSave = () => {
    const amt = Number(amount);
    if (isNaN(amt) || amt <= 0) { toast({ title: "Enter a valid amount", variant: "destructive" }); return; }
    const recipients: Array<"resident" | "guardian" | { phone?: string; email?: string }> =
      recipient === "custom"
        ? [custom.includes("@") ? { email: custom.trim() } : { phone: custom.trim() }]
        : [recipient];
    if (recipient === "custom" && !custom.trim()) { toast({ title: "Enter a phone or email", variant: "destructive" }); return; }
    setShortUrl(null);
    setNotConfigured(false);
    mut.mutate({ amount: amt, recipients });
  };

  const copyLink = () => {
    if (shortUrl) {
      navigator.clipboard?.writeText(shortUrl);
      toast({ title: "Link copied" });
    }
  };

  return (
    <FormModal
      open={open}
      onOpenChange={onOpenChange}
      title={`Share Payment Link — ${resident.name}`}
      onSave={shortUrl || notConfigured ? undefined : onSave}
      isSaving={mut.isPending}
      saveLabel="Generate & Send"
    >
      <div className="space-y-4">
        {notConfigured ? (
          <div className="rounded-md bg-surface border p-4 text-sm text-muted-foreground" data-testid="payment-link-not-configured">
            <p className="font-medium text-primary mb-1">Payments gateway not configured yet</p>
            Online payment links aren't available until the Razorpay keys are set up. Please contact your administrator.
          </div>
        ) : shortUrl ? (
          <div className="space-y-3" data-testid="payment-link-result">
            <div className="rounded-md bg-success/5 border border-success/20 p-3 text-sm">
              <p className="font-medium text-success mb-1">Payment link created &amp; shared</p>
              <a href={shortUrl} target="_blank" rel="noreferrer" className="font-mono text-xs text-accent underline break-all">{shortUrl}</a>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={copyLink}>
              <Copy className="w-3.5 h-3.5 mr-1" /> Copy link
            </Button>
          </div>
        ) : (
          <>
            <div>
              <Label>Recipient *</Label>
              <Select value={recipient} onValueChange={(v) => setRecipient(v as LinkRecipient)}>
                <SelectTrigger data-testid="select-link-recipient"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="resident">Resident{resident.phone ? ` · ${resident.phone}` : ""}</SelectItem>
                  <SelectItem value="guardian">Guardian{resident.parentPhone ? ` · ${resident.parentPhone}` : ""}</SelectItem>
                  <SelectItem value="custom">Custom phone or email</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {recipient === "custom" && (
              <div>
                <Label>Phone or Email *</Label>
                <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="9876543210 or name@email.com" data-testid="input-link-custom" />
              </div>
            )}
            <div>
              <Label>Amount (₹) *</Label>
              <Input type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="input-link-amount" />
              <p className="text-xs text-muted-foreground mt-1">Prefilled to outstanding dues. Link expires in 7 days.</p>
            </div>
          </>
        )}
      </div>
    </FormModal>
  );
}
