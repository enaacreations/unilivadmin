import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMarkAttendance, useUpdateAttendance } from "@workspace/api-client-react";
import { apiFetch, apiDownload } from "@/lib/api-fetch";
import { usePermissions } from "@/lib/use-permissions";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import { Download, CheckCircle2, UserCheck, UserX, Coffee, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const STATUSES = ["PRESENT", "ABSENT", "HALF_DAY", "WFH", "ON_LEAVE"];

interface AttRow {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string;
  record: { id: string; status: string } | null;
}

export default function Attendance() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { can } = usePermissions();
  const canEdit = can("EMPLOYEES", "edit");
  const [date, setDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [department, setDepartment] = React.useState("ALL");
  const [selected, setSelected] = React.useState<Record<string, boolean>>({});

  const createMut = useMarkAttendance();
  const updateMut = useUpdateAttendance();

  const { data: res, isLoading } = useQuery({
    queryKey: ["attendance-by-date", date],
    queryFn: () => apiFetch<{ success: boolean; data: AttRow[] }>(`/attendance/by-date?date=${date}`),
  });
  const rows = res?.data || [];

  const departments = React.useMemo(() => Array.from(new Set(rows.map((r) => r.department))).sort(), [rows]);
  const visible = React.useMemo(() => rows.filter((r) => department === "ALL" || r.department === department), [rows, department]);

  const counts = React.useMemo(() => {
    const c = { PRESENT: 0, ABSENT: 0, ON_LEAVE: 0, HALF_DAY: 0, WFH: 0 };
    for (const r of rows) if (r.record?.status && (c as any)[r.record.status] !== undefined) (c as any)[r.record.status]++;
    return c;
  }, [rows]);

  const setStatus = async (row: AttRow, status: string) => {
    try {
      if (row.record) {
        await updateMut.mutateAsync({ id: row.record.id, data: { employeeId: row.employeeId, date, status } as any });
      } else {
        await createMut.mutateAsync({ data: { employeeId: row.employeeId, date, status } });
      }
      qc.invalidateQueries({ queryKey: ["attendance-by-date", date] });
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  };

  const markAllPresent = async () => {
    try {
      const ids = visible.map((r) => r.employeeId);
      if (ids.length === 0) return;
      await apiFetch("/attendance/bulk", {
        method: "POST",
        body: JSON.stringify({ employeeIds: ids, date, status: "PRESENT" }),
      });
      toast({ title: `Marked ${ids.length} present` });
      qc.invalidateQueries({ queryKey: ["attendance-by-date", date] });
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  };

  const markSelectedPresent = async () => {
    try {
      const ids = Object.entries(selected).filter(([, v]) => v).map(([k]) => k);
      if (ids.length === 0) {
        toast({ title: "Select at least one employee" });
        return;
      }
      await apiFetch("/attendance/bulk", {
        method: "POST",
        body: JSON.stringify({ employeeIds: ids, date, status: "PRESENT" }),
      });
      toast({ title: `Marked ${ids.length} present` });
      setSelected({});
      qc.invalidateQueries({ queryKey: ["attendance-by-date", date] });
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  };

  const exportCsv = async () => {
    try {
      const d = new Date(date);
      // Authenticated download via apiDownload: attaches the in-memory token
      // (with 401→refresh→retry) and saves the returned blob.
      await apiDownload(
        `/api/attendance/export-csv?year=${d.getFullYear()}&month=${d.getMonth() + 1}`,
        `attendance-${d.getFullYear()}-${d.getMonth() + 1}.csv`,
      );
    } catch (e: any) {
      toast({ title: e?.message || "Export failed", variant: "destructive" });
    }
  };

  const allChecked = visible.length > 0 && visible.every((r) => selected[r.employeeId]);
  const toggleAll = () => {
    const next: Record<string, boolean> = {};
    if (!allChecked) for (const r of visible) next[r.employeeId] = true;
    setSelected(next);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Attendance"
        subtitle="Daily staff attendance tracking"
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={exportCsv} data-testid="button-export-csv">
              <Download className="w-4 h-4 mr-2" /> Export CSV
            </Button>
            {canEdit && (
              <Button className="bg-accent hover:bg-accent/90 text-white" onClick={markAllPresent} data-testid="button-mark-all-present">
                <CheckCircle2 className="w-4 h-4 mr-2" /> Mark all Present
              </Button>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Present Today" value={counts.PRESENT} icon={UserCheck} />
        <StatCard title="Absent Today" value={counts.ABSENT} icon={UserX} />
        <StatCard title="On Leave Today" value={counts.ON_LEAVE} icon={Coffee} />
        <StatCard title="Total Active" value={rows.length} icon={Users} />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">Date</Label>
          <DatePicker value={date} onChange={setDate} className="w-44" data-testid="input-date" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Department</Label>
          <Select value={department} onValueChange={setDepartment}>
            <SelectTrigger className="w-48" data-testid="select-department"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Departments</SelectItem>
              {departments.map((d) => (<SelectItem key={d} value={d}>{d}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
        {canEdit && Object.values(selected).some(Boolean) && (
          <Button variant="outline" onClick={markSelectedPresent}>
            Mark selected Present ({Object.values(selected).filter(Boolean).length})
          </Button>
        )}
      </div>

      <Card className="shadow-sm">
        <CardContent className="p-0">
          <BoundedScroll size="lg">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b sticky top-0 z-10">
                <tr>
                  <th className="p-3 text-left w-10"><Checkbox checked={allChecked} onCheckedChange={toggleAll} /></th>
                  <th className="p-3 text-left font-medium text-xs uppercase tracking-wider text-muted-foreground">Code</th>
                  <th className="p-3 text-left font-medium text-xs uppercase tracking-wider text-muted-foreground">Name</th>
                  <th className="p-3 text-left font-medium text-xs uppercase tracking-wider text-muted-foreground">Department</th>
                  <th className="p-3 text-left font-medium text-xs uppercase tracking-wider text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i} className="border-b">
                      <td colSpan={5} className="p-3"><Skeleton className="h-8 w-full" /></td>
                    </tr>
                  ))
                ) : visible.length === 0 ? (
                  <tr><td colSpan={5} className="p-12 text-center text-muted-foreground">No active employees</td></tr>
                ) : (
                  visible.map((row) => (
                    <tr key={row.employeeId} className="border-b hover:bg-muted/20">
                      <td className="p-3">
                        <Checkbox
                          checked={!!selected[row.employeeId]}
                          onCheckedChange={(v) => setSelected((p) => ({ ...p, [row.employeeId]: !!v }))}
                        />
                      </td>
                      <td className="p-3"><span className="font-mono text-xs bg-muted/30 px-2 py-1 rounded">{row.employeeCode}</span></td>
                      <td className="p-3 font-medium text-primary">{row.employeeName}</td>
                      <td className="p-3"><Badge variant="secondary" className="text-xs uppercase">{row.department}</Badge></td>
                      <td className="p-3">
                        <Select
                          value={row.record?.status || ""}
                          onValueChange={(v) => setStatus(row, v)}
                          disabled={!canEdit}
                        >
                          <SelectTrigger className="w-44 h-8" data-testid={`select-status-${row.employeeId}`}>
                            <SelectValue placeholder="Mark status" />
                          </SelectTrigger>
                          <SelectContent>
                            {STATUSES.map((s) => (<SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>))}
                          </SelectContent>
                        </Select>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </BoundedScroll>
        </CardContent>
      </Card>
    </div>
  );
}
