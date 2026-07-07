import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import {
  Search, Plus, Download, ChevronDown, Pencil, Trash2, Database,
  FileDown, FileText, FileSpreadsheet, CheckCircle2, XCircle, AlertCircle,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { FormModal } from "@/components/ui/form-modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/lib/use-permissions";
import { apiDownload } from "@/lib/api-fetch";
import {
  mastersApi, masterKeys, masterRegistry, editableColumns,
  type MasterColumn, type MasterRow, type ExportFmt, type BulkAction,
} from "@/lib/masters-api";

/** Build the initial form state for a create/edit: editable string cols default
 *  to "" (or the existing value), isActive/booleans default to true (or value). */
function initialForm(cols: MasterColumn[], row?: MasterRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) {
    if (c.type === "boolean") {
      out[c.key] = row ? Boolean(row[c.key]) : c.key === "isActive" ? true : false;
    } else {
      out[c.key] = row && row[c.key] != null ? String(row[c.key]) : "";
    }
  }
  return out;
}

export default function MasterTable() {
  const { type = "" } = useParams<{ type: string }>();
  const entry = masterRegistry(type);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { can } = usePermissions();

  const canCreate = can("FOOD_SETTINGS", "create");
  const canEdit = can("FOOD_SETTINGS", "edit");
  const canDelete = can("FOOD_SETTINGS", "delete");
  // Read-only viewers (e.g. AUDIT_READONLY) get no Actions column at all —
  // every control inside it is edit/delete-gated, so it would render empty.
  const showActions = canEdit || canDelete;

  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [includeInactive, setIncludeInactive] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editRow, setEditRow] = React.useState<MasterRow | null>(null);
  const [form, setForm] = React.useState<Record<string, unknown>>({});

  const [deleteRow, setDeleteRow] = React.useState<MasterRow | null>(null);
  const [bulkConfirm, setBulkConfirm] = React.useState<BulkAction | null>(null);

  // Debounce the search box so we don't refetch on every keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset transient state whenever the master type changes (route param swap).
  React.useEffect(() => {
    setSearch(""); setDebounced(""); setIncludeInactive(false); setSelected(new Set());
  }, [type]);

  const listParams = { q: debounced || undefined, includeInactive: includeInactive || undefined };
  const { data: rows, isLoading, isError, error } = useQuery({
    queryKey: masterKeys.list(type, listParams),
    queryFn: () => mastersApi.list(type, listParams),
    enabled: !!entry,
  });

  const data = rows ?? [];
  const editable = entry ? editableColumns(entry) : [];
  // Columns shown in the table = every registry column (incl FK ids + isActive).
  const displayCols = entry?.columns ?? [];

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["masters"] });

  // ── Mutations ──────────────────────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => mastersApi.create(type, body),
    onSuccess: () => {
      toast({ title: `${entry?.label?.replace(/s$/, "") ?? "Record"} created` });
      setCreateOpen(false); invalidate();
    },
    onError: (e: any) => toast({ title: e?.message || "Failed to create", variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      mastersApi.update(type, id, body),
    onSuccess: () => {
      toast({ title: "Saved" });
      setEditRow(null); invalidate();
    },
    onError: (e: any) => toast({ title: e?.message || "Failed to save", variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => mastersApi.remove(type, id),
    onSuccess: () => {
      toast({ title: "Deleted" });
      setDeleteRow(null); invalidate();
    },
    onError: (e: any) => toast({ title: e?.message || "Failed to delete", variant: "destructive" }),
  });

  const bulkMut = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: BulkAction }) =>
      mastersApi.bulk(type, ids, action),
    onSuccess: (res) => {
      const verb = res.action === "delete" ? "deleted" : `${res.action}d`;
      toast({
        title: `${res.affected} ${res.affected === 1 ? "record" : "records"} ${verb}`,
        description: res.skipped > 0 ? `${res.skipped} skipped (still in use).` : undefined,
      });
      setSelected(new Set()); setBulkConfirm(null); invalidate();
    },
    onError: (e: any) => toast({ title: e?.message || "Bulk action failed", variant: "destructive" }),
  });

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const openCreate = () => { setForm(initialForm(editable)); setCreateOpen(true); };
  const openEdit = (row: MasterRow) => { setForm(initialForm(editable, row)); setEditRow(row); };

  /** Strip empty optional strings; required validation is left to the server,
   *  but we block obviously-empty required fields client-side for fast feedback. */
  const buildBody = (): Record<string, unknown> | null => {
    const body: Record<string, unknown> = {};
    for (const c of editable) {
      const v = form[c.key];
      if (c.type === "boolean") { body[c.key] = Boolean(v); continue; }
      const s = typeof v === "string" ? v.trim() : v;
      if (c.required && (s === "" || s == null)) {
        toast({ title: `${c.label} is required`, variant: "destructive" });
        return null;
      }
      // Send "" through for editable optional strings so PATCH can clear them;
      // for create we still send them (server treats "" as empty/null).
      body[c.key] = s;
    }
    return body;
  };

  const submitCreate = () => { const b = buildBody(); if (b) createMut.mutate(b); };
  const submitEdit = () => {
    if (!editRow) return;
    const b = buildBody();
    if (b) updateMut.mutate({ id: editRow.id, body: b });
  };

  const toggleActive = (row: MasterRow) =>
    updateMut.mutate({ id: row.id, body: { isActive: !row.isActive } });

  const allSelected = data.length > 0 && data.every((r) => selected.has(r.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(data.map((r) => r.id)));
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const doExport = async (fmt: ExportFmt) => {
    try {
      await apiDownload(
        mastersApi.exportUrl(type, fmt, listParams),
        mastersApi.exportFilename(type, fmt),
      );
    } catch (e: any) {
      toast({ title: e?.message || "Export failed", variant: "destructive" });
    }
  };

  // ── Unknown type → not-found state ───────────────────────────────────────────
  if (!entry) {
    return (
      <div className="space-y-6">
        <PageHeader title="Masters" breadcrumbs={[{ label: "Masters", href: "/masters" }, { label: "Unknown" }]} />
        <EmptyState
          icon={AlertCircle}
          title="Unknown master type"
          description={`There is no master called "${type}".`}
          action={<Link href="/masters"><Button variant="outline">Back to Masters</Button></Link>}
        />
      </div>
    );
  }

  const renderCell = (col: MasterColumn, row: MasterRow) => {
    const v = row[col.key];
    if (col.key === "isActive") {
      return row.isActive
        ? <Badge variant="success" className="text-xs">Active</Badge>
        : <Badge variant="outline" className="text-xs text-muted-foreground">Inactive</Badge>;
    }
    if (col.type === "boolean") return v ? "Yes" : "No";
    if (v == null || v === "") return <span className="text-muted-foreground">—</span>;
    if (col.key === "code") {
      return <span className="font-mono text-xs bg-muted/30 px-2 py-1 rounded">{String(v)}</span>;
    }
    if (col.key === "name") return <span className="font-medium text-primary">{String(v)}</span>;
    return String(v);
  };

  const selectedCount = selected.size;

  return (
    <div className="space-y-6">
      <PageHeader
        title={entry.label}
        subtitle={`Manage ${entry.label.toLowerCase()} reference data`}
        breadcrumbs={[{ label: "Masters", href: "/masters" }, { label: entry.label }]}
        action={
          canCreate ? (
            <Button className="bg-accent hover:bg-accent/90 text-white" onClick={openCreate}>
              <Plus className="w-4 h-4 mr-2" /> Add {entry.label.replace(/s$/, "")}
            </Button>
          ) : undefined
        }
      />

      {/* Toolbar: search + show-inactive + export */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={`Search ${entry.label.toLowerCase()}...`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
          <Switch checked={includeInactive} onCheckedChange={setIncludeInactive} />
          Show inactive
        </label>
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={isLoading || data.length === 0}>
                <Download className="mr-2 h-4 w-4" /> Export
                <ChevronDown className="ml-2 h-4 w-4 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuLabel>Export</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => doExport("csv")}>
                <FileDown className="mr-2 h-4 w-4 text-muted-foreground" /> CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => doExport("xlsx")}>
                <FileSpreadsheet className="mr-2 h-4 w-4 text-success" /> Excel
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => doExport("pdf")}>
                <FileText className="mr-2 h-4 w-4 text-destructive" /> PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedCount > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-surface/60 px-4 py-3">
          <span className="text-sm font-medium text-primary">
            {selectedCount} selected
          </span>
          <div className="flex items-center gap-2">
            {canEdit && (
              <>
                <Button variant="outline" size="sm" onClick={() => setBulkConfirm("activate")} disabled={bulkMut.isPending}>
                  <CheckCircle2 className="mr-2 h-4 w-4 text-success" /> Activate
                </Button>
                <Button variant="outline" size="sm" onClick={() => setBulkConfirm("deactivate")} disabled={bulkMut.isPending}>
                  <XCircle className="mr-2 h-4 w-4 text-muted-foreground" /> Deactivate
                </Button>
              </>
            )}
            {canDelete && (
              <Button variant="outline" size="sm" className="text-destructive" onClick={() => setBulkConfirm("delete")} disabled={bulkMut.isPending}>
                <Trash2 className="mr-2 h-4 w-4" /> Delete
              </Button>
            )}
          </div>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-md border bg-card">
        {isError ? (
          <div className="flex items-center gap-3 p-6 text-sm text-destructive">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span>{(error as Error)?.message || "Failed to load records."}</span>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={toggleAll}
                    aria-label="Select all"
                    disabled={data.length === 0}
                  />
                </TableHead>
                {displayCols.map((c) => (
                  <TableHead key={c.key}>{c.label}</TableHead>
                ))}
                {showActions && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-4" /></TableCell>
                    {displayCols.map((c) => (
                      <TableCell key={c.key}><Skeleton className="h-6 w-full" /></TableCell>
                    ))}
                    {showActions && <TableCell><Skeleton className="h-6 w-16 ml-auto" /></TableCell>}
                  </TableRow>
                ))
              ) : data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={displayCols.length + (showActions ? 2 : 1)} className="h-32 text-center">
                    <div className="flex flex-col items-center justify-center text-muted-foreground py-6">
                      <Database className="h-8 w-8 mb-2" />
                      <p>{debounced || includeInactive ? "No matching records." : "No records yet."}</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                data.map((row) => (
                  <TableRow key={row.id} data-state={selected.has(row.id) ? "selected" : undefined}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(row.id)}
                        onCheckedChange={() => toggleOne(row.id)}
                        aria-label="Select row"
                      />
                    </TableCell>
                    {displayCols.map((c) => (
                      <TableCell key={c.key}>{renderCell(c, row)}</TableCell>
                    ))}
                    {showActions && (
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          {canEdit && (
                            <Switch
                              checked={Boolean(row.isActive)}
                              onCheckedChange={() => toggleActive(row)}
                              aria-label="Toggle active"
                            />
                          )}
                          {canEdit && (
                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(row)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                          )}
                          {canDelete && (
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setDeleteRow(row)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Create modal */}
      <FormModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={`Add ${entry.label.replace(/s$/, "")}`}
        onSave={submitCreate}
        isSaving={createMut.isPending}
        saveLabel="Create"
      >
        <MasterForm cols={editable} form={form} setForm={setForm} />
      </FormModal>

      {/* Edit modal */}
      <FormModal
        open={!!editRow}
        onOpenChange={(o) => { if (!o) setEditRow(null); }}
        title={`Edit ${entry.label.replace(/s$/, "")}`}
        onSave={submitEdit}
        isSaving={updateMut.isPending}
        saveLabel="Save"
      >
        <MasterForm cols={editable} form={form} setForm={setForm} />
      </FormModal>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteRow}
        onOpenChange={(o) => { if (!o) setDeleteRow(null); }}
        title="Delete record?"
        description="This permanently removes the record. If it is referenced elsewhere, deactivate it instead."
        confirmLabel="Delete"
        isConfirming={deleteMut.isPending}
        onConfirm={() => deleteRow && deleteMut.mutate(deleteRow.id)}
      />

      {/* Bulk confirm */}
      <ConfirmDialog
        open={!!bulkConfirm}
        onOpenChange={(o) => { if (!o) setBulkConfirm(null); }}
        title={
          bulkConfirm === "delete" ? `Delete ${selectedCount} records?`
            : bulkConfirm === "activate" ? `Activate ${selectedCount} records?`
              : `Deactivate ${selectedCount} records?`
        }
        description={
          bulkConfirm === "delete"
            ? "Records still referenced elsewhere will be skipped and left untouched."
            : `This will ${bulkConfirm} the selected records.`
        }
        confirmLabel={bulkConfirm === "delete" ? "Delete" : bulkConfirm === "activate" ? "Activate" : "Deactivate"}
        variant={bulkConfirm === "delete" ? "destructive" : "default"}
        isConfirming={bulkMut.isPending}
        onConfirm={() => bulkConfirm && bulkMut.mutate({ ids: Array.from(selected), action: bulkConfirm })}
      />
    </div>
  );
}

/** Config-driven form body: one field per editable column. */
function MasterForm({
  cols, form, setForm,
}: {
  cols: MasterColumn[];
  form: Record<string, unknown>;
  setForm: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
}) {
  const set = (key: string, value: unknown) => setForm((prev) => ({ ...prev, [key]: value }));
  return (
    <div className="space-y-5">
      {cols.map((c) => {
        if (c.type === "boolean") {
          return (
            <div key={c.key} className="flex items-center justify-between rounded-lg border p-3">
              <Label htmlFor={`field-${c.key}`} className="text-sm">{c.label}</Label>
              <Switch
                id={`field-${c.key}`}
                checked={Boolean(form[c.key])}
                onCheckedChange={(v) => set(c.key, v)}
              />
            </div>
          );
        }
        return (
          <div key={c.key} className="space-y-2">
            <Label htmlFor={`field-${c.key}`}>
              {c.label}
              {c.required && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <Input
              id={`field-${c.key}`}
              value={(form[c.key] as string) ?? ""}
              onChange={(e) => set(c.key, e.target.value)}
              placeholder={c.type === "id" ? `${c.label} id` : c.label}
            />
            {c.type === "id" && (
              <p className="text-xs text-muted-foreground">Enter the referenced record id.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
