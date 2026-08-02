import * as React from "react";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Settings2, Check, X, Banknote, Receipt, Wallet, AlertCircle } from "lucide-react";
import { FormModal } from "@/components/ui/form-modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";
import { useGetProperties, useGetVendors } from "@workspace/api-client-react";
import type { ExpenseDto, ExpenseCategoryDto, CreateExpenseBody, ExpenseDtoStatus } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

type ExpenseForm = {
  categoryId: string;
  propertyId: string;
  vendor: string;
  amount: string;
  expenseDate: string;
  description: string;
  reference: string;
  attachment: string;
};
type TransitionAction = "APPROVED" | "REJECTED" | "PAID";

export default function ExpensesPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Expense Management" subtitle="Track operational expenses with approval workflow" />
      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">Expenses</TabsTrigger>
          <TabsTrigger value="categories">Categories</TabsTrigger>
        </TabsList>
        <TabsContent value="list" className="mt-4"><ExpensesTab /></TabsContent>
        <TabsContent value="categories" className="mt-4"><CategoriesTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function ExpensesTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = React.useState({ status: "ALL", propertyId: "ALL", categoryId: "ALL" });

  const queryStr = React.useMemo(() => {
    const p = new URLSearchParams();
    if (filter.status !== "ALL") p.set("status", filter.status);
    if (filter.propertyId !== "ALL") p.set("propertyId", filter.propertyId);
    if (filter.categoryId !== "ALL") p.set("categoryId", filter.categoryId);
    const s = p.toString();
    return s ? `?${s}` : "";
  }, [filter]);

  const { data: expRes, isLoading } = useQuery<{ success: boolean; data: ExpenseDto[]; meta: { totals: Record<string, number> } }>({
    queryKey: ["expenses", queryStr], queryFn: () => apiFetch(`/expenses${queryStr}`),
  });
  const expenses = expRes?.data || [];
  const totals: Record<string, number> = expRes?.meta?.totals || {};
  const { data: catsRes } = useQuery<{ success: boolean; data: ExpenseCategoryDto[] }>({ queryKey: ["expense-categories"], queryFn: () => apiFetch("/expense-categories") });
  const categories = catsRes?.data || [];
  const { data: propsRes } = useGetProperties();
  const properties = propsRes?.data || [];
  const { data: vendorsRes } = useGetVendors();
  const vendors = vendorsRes?.data || [];

  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ExpenseDto | null>(null);
  const [delId, setDelId] = React.useState<string | null>(null);
  const initial: ExpenseForm = { categoryId: "", propertyId: "", vendor: "", amount: "", expenseDate: format(new Date(), "yyyy-MM-dd"), description: "", reference: "", attachment: "" };
  const [form, setForm] = React.useState<ExpenseForm>(initial);

  React.useEffect(() => {
    if (editing) {
      setForm({
        categoryId: editing.categoryId || "",
        propertyId: editing.propertyId || "",
        vendor: editing.vendor || "",
        amount: editing.amount,
        expenseDate: format(new Date(editing.expenseDate), "yyyy-MM-dd"),
        description: editing.description || "",
        reference: editing.reference || "",
        attachment: editing.attachment || "",
      });
    } else setForm(initial);
  }, [editing, open]);

  const saveMut = useMutation({
    mutationFn: (d: CreateExpenseBody) => editing
      ? apiFetch(`/expenses/${editing.id}`, { method: "PUT", body: JSON.stringify(d) })
      : apiFetch("/expenses", { method: "POST", body: JSON.stringify(d) }),
    onSuccess: () => { toast({ title: editing ? "Updated" : "Submitted for approval" }); qc.invalidateQueries({ queryKey: ["expenses"] }); setOpen(false); setEditing(null); },
    onError: (e: Error) => toast({ title: e.message || "Failed", variant: "destructive" }),
  });

  const transitionMut = useMutation({
    mutationFn: ({ id, action, note }: { id: string; action: TransitionAction; note?: string }) =>
      apiFetch(`/expenses/${id}/transition`, { method: "POST", body: JSON.stringify({ action, note }) }),
    onSuccess: () => { toast({ title: "Updated" }); qc.invalidateQueries({ queryKey: ["expenses"] }); },
    onError: (e: Error) => toast({ title: e.message || "Failed", variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/expenses/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast({ title: "Deleted" }); qc.invalidateQueries({ queryKey: ["expenses"] }); setDelId(null); },
  });

  const onFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setForm((f) => ({ ...f, attachment: String(reader.result || "") }));
    reader.readAsDataURL(file);
  };

  const onSubmit = () => {
    saveMut.mutate({
      ...form,
      categoryId: form.categoryId || null,
      propertyId: form.propertyId || null,
      amount: form.amount,
    });
  };

  const vendorOptions: ComboboxOption[] = React.useMemo(() => {
    const names = new Set<string>(vendors.map((v) => v.name));
    if (form.vendor) names.add(form.vendor);
    return Array.from(names).sort().map((n) => ({ value: n, label: n }));
  }, [vendors, form.vendor]);

  const statusBadge = (s: ExpenseDtoStatus | string) => {
    const map: Record<string, "success" | "warning" | "destructive" | "outline"> = {
      APPROVED: "success", PAID: "success", REJECTED: "destructive", SUBMITTED: "warning",
    };
    return <Badge variant={map[s] ?? "outline"}>{s}</Badge>;
  };

  const columns = [
    { accessorKey: "expenseDate", header: "Date", cell: ({row}:any) => format(new Date(row.original.expenseDate), "dd MMM yyyy") },
    { accessorKey: "categoryName", header: "Category", cell: ({row}:any) => row.original.categoryName || "—" },
    { accessorKey: "vendor", header: "Vendor", cell: ({row}:any) => row.original.vendor || "—" },
    { accessorKey: "propertyName", header: "Property", cell: ({row}:any) => row.original.propertyName || "—" },
    { accessorKey: "description", header: "Description", cell: ({row}:any) => <span className="text-muted-foreground truncate max-w-[200px] block">{row.original.description || "—"}</span> },
    { accessorKey: "amount", header: "Amount", cell: ({row}:any) => <span className="font-mono font-medium">₹{Number(row.original.amount).toLocaleString("en-IN")}</span> },
    { accessorKey: "status", header: "Status", cell: ({row}:any) => statusBadge(row.original.status) },
    { id: "actions", header: "", cell: ({row}:any) => (
      <div className="flex gap-1 justify-end">
        {row.original.status === "SUBMITTED" && (
          <>
            <Button size="sm" variant="outline" className="text-success" onClick={() => transitionMut.mutate({id: row.original.id, action: "APPROVED"})} data-testid={`button-approve-expense-${row.original.id}`}>
              <Check className="w-3 h-3" />
            </Button>
            <Button size="sm" variant="outline" className="text-destructive" onClick={() => {
              const note = window.prompt("Reason for rejection?") || "";
              transitionMut.mutate({id: row.original.id, action: "REJECTED", note});
            }}>
              <X className="w-3 h-3" />
            </Button>
          </>
        )}
        {row.original.status === "APPROVED" && (
          <Button size="sm" variant="outline" onClick={() => transitionMut.mutate({id: row.original.id, action: "PAID"})}>
            <Banknote className="w-3 h-3 mr-1" /> Mark Paid
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => { setEditing(row.original); setOpen(true); }}><Settings2 className="w-4 h-4" /></Button>
        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDelId(row.original.id)}><Trash2 className="w-4 h-4" /></Button>
      </div>
    )},
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Total" value={`₹${(totals.total || 0).toLocaleString("en-IN")}`} icon={Receipt} />
        <StatCard title="Pending Approval" value={`₹${(totals.SUBMITTED || 0).toLocaleString("en-IN")}`} icon={AlertCircle} />
        <StatCard title="Approved" value={`₹${(totals.APPROVED || 0).toLocaleString("en-IN")}`} icon={Wallet} />
        <StatCard title="Paid" value={`₹${(totals.PAID || 0).toLocaleString("en-IN")}`} icon={Banknote} />
      </div>

      <div className="flex flex-wrap gap-3">
        <Select value={filter.status} onValueChange={v => setFilter({...filter, status: v})}>
          <SelectTrigger className="w-44" data-testid="select-filter-expense-status"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Status</SelectItem>
            <SelectItem value="SUBMITTED">Submitted</SelectItem>
            <SelectItem value="APPROVED">Approved</SelectItem>
            <SelectItem value="REJECTED">Rejected</SelectItem>
            <SelectItem value="PAID">Paid</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filter.propertyId} onValueChange={v => setFilter({...filter, propertyId: v})}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Property" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Properties</SelectItem>
            {properties.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filter.categoryId} onValueChange={v => setFilter({...filter, categoryId: v})}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Category" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Categories</SelectItem>
            {categories.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="ml-auto">
          <Button onClick={() => { setEditing(null); setOpen(true); }} className="bg-accent hover:bg-accent/90 text-white" data-testid="button-add-expense">
            <Plus className="w-4 h-4 mr-2" /> Record Expense
          </Button>
        </div>
      </div>

      <DataTable columns={columns} data={expenses} isLoading={isLoading} />

      <FormModal open={open} onOpenChange={setOpen} title={editing ? "Edit Expense" : "Record Expense"} onSave={onSubmit} isSaving={saveMut.isPending}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Amount (₹) *</Label>
              <Input type="number" min={0} value={form.amount} onChange={e => setForm({...form, amount: e.target.value})} data-testid="input-expense-amount" />
            </div>
            <div>
              <Label>Date *</Label>
              <DatePicker value={form.expenseDate} onChange={v => setForm({...form, expenseDate: v})} />
            </div>
          </div>
          <div>
            <Label>Category</Label>
            <Select value={form.categoryId} onValueChange={v => setForm({...form, categoryId: v})}>
              <SelectTrigger data-testid="select-expense-category"><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                {categories.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Property</Label>
            <Select value={form.propertyId} onValueChange={v => setForm({...form, propertyId: v})}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                {properties.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Vendor</Label>
            <Combobox
              options={vendorOptions}
              value={form.vendor || null}
              onChange={v => setForm({...form, vendor: v || ""})}
              placeholder="Select vendor"
              searchPlaceholder="Search vendors…"
              emptyText="No vendors found."
              allowClear
            />
          </div>
          <div><Label>Reference / Bill No.</Label><Input value={form.reference} onChange={e => setForm({...form, reference: e.target.value})} /></div>
          <div><Label>Description</Label><Textarea rows={3} value={form.description} onChange={e => setForm({...form, description: e.target.value})} /></div>
          <div>
            <Label>Attachment</Label>
            <Input type="file" accept="image/*,application/pdf" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
            {form.attachment && <p className="text-xs text-muted-foreground mt-1">Attached ({Math.round(form.attachment.length / 1024)} KB)</p>}
          </div>
        </div>
      </FormModal>

      <ConfirmDialog open={!!delId} onOpenChange={(op) => !op && setDelId(null)} title="Delete expense?" description="This expense record will be permanently deleted." onConfirm={() => delId && delMut.mutate(delId)} isConfirming={delMut.isPending} />
    </div>
  );
}

function CategoriesTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: catsRes, isLoading } = useQuery<{ success: boolean; data: ExpenseCategoryDto[] }>({ queryKey: ["expense-categories"], queryFn: () => apiFetch("/expense-categories") });
  const cats = catsRes?.data || [];

  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({ name: "", description: "" });
  const [delId, setDelId] = React.useState<string | null>(null);

  const saveMut = useMutation({
    mutationFn: (d: { name: string; description: string }) => apiFetch("/expense-categories", { method: "POST", body: JSON.stringify(d) }),
    onSuccess: () => { toast({ title: "Created" }); qc.invalidateQueries({ queryKey: ["expense-categories"] }); setOpen(false); setForm({ name: "", description: "" }); },
    onError: (e: Error) => toast({ title: e.message || "Failed", variant: "destructive" }),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/expense-categories/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["expense-categories"] }); setDelId(null); },
  });

  const columns = [
    { accessorKey: "name", header: "Name", cell: ({row}:any) => <span className="font-medium">{row.original.name}</span> },
    { accessorKey: "description", header: "Description", cell: ({row}:any) => row.original.description || "—" },
    { id: "actions", header: "", cell: ({row}:any) => (
      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDelId(row.original.id)}><Trash2 className="w-4 h-4" /></Button>
    )},
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)} className="bg-accent hover:bg-accent/90 text-white" data-testid="button-add-category">
          <Plus className="w-4 h-4 mr-2" /> New Category
        </Button>
      </div>
      <DataTable columns={columns} data={cats} isLoading={isLoading} />
      <FormModal open={open} onOpenChange={setOpen} title="New Category" onSave={() => saveMut.mutate(form)} isSaving={saveMut.isPending}>
        <div className="space-y-4">
          <div><Label>Name *</Label><Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} data-testid="input-category-name" /></div>
          <div><Label>Description</Label><Textarea rows={3} value={form.description} onChange={e => setForm({...form, description: e.target.value})} /></div>
        </div>
      </FormModal>
      <ConfirmDialog open={!!delId} onOpenChange={(op) => !op && setDelId(null)} title="Delete category?" description="Existing expenses keep their reference but show no category." onConfirm={() => delId && delMut.mutate(delId)} isConfirming={delMut.isPending} />
    </div>
  );
}
