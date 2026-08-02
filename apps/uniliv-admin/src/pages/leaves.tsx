import * as React from "react";
import {
  useGetLeaves,
  getGetLeavesQueryKey,
  useUpdateLeave,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Check, X, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const TABS: Array<"ALL" | "PENDING" | "APPROVED" | "REJECTED"> = ["ALL", "PENDING", "APPROVED", "REJECTED"];

export default function Leaves() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = React.useState<"ALL" | "PENDING" | "APPROVED" | "REJECTED">("ALL");
  const [search, setSearch] = React.useState("");

  const { data: leavesRes, isLoading } = useGetLeaves(undefined, {
    query: { queryKey: getGetLeavesQueryKey() },
  });
  const leaves = leavesRes?.data || [];

  const updateLeave = useUpdateLeave();

  const counts = React.useMemo(() => {
    const c: Record<string, number> = { ALL: leaves.length, PENDING: 0, APPROVED: 0, REJECTED: 0 };
    for (const l of leaves) c[l.status] = (c[l.status] || 0) + 1;
    return c;
  }, [leaves]);

  const filtered = React.useMemo(() => {
    return leaves.filter((l) => {
      if (tab !== "ALL" && l.status !== tab) return false;
      if (search && !(l.employeeName || "").toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [leaves, tab, search]);

  const handleAction = (id: string, status: string, e: React.MouseEvent) => {
    e.stopPropagation();
    updateLeave.mutate(
      { id, data: { status } },
      {
        onSuccess: () => {
          toast({ title: `Leave ${status.toLowerCase()}` });
          qc.invalidateQueries({ queryKey: getGetLeavesQueryKey() });
        },
        onError: (err: any) => toast({ title: err?.message || "Failed", variant: "destructive" }),
      }
    );
  };

  const columns = [
    {
      accessorKey: "employeeName",
      header: "Employee",
      cell: ({ row }: any) => (
        <span className="font-medium text-primary">{row.original.employeeName || "Unknown"}</span>
      ),
    },
    {
      accessorKey: "type",
      header: "Type",
      cell: ({ row }: any) => <Badge variant="outline">{row.original.type}</Badge>,
    },
    {
      accessorKey: "duration",
      header: "Duration",
      cell: ({ row }: any) => (
        <div>
          <div className="text-sm font-medium">
            {new Date(row.original.fromDate).toLocaleDateString()} – {new Date(row.original.toDate).toLocaleDateString()}
          </div>
          <div className="text-xs text-muted-foreground">{row.original.days} day(s)</div>
        </div>
      ),
    },
    {
      accessorKey: "reason",
      header: "Reason",
      cell: ({ row }: any) => (
        <span className="max-w-[260px] truncate block" title={row.original.reason}>
          {row.original.reason}
        </span>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }: any) => <StatusBadge status={row.original.status} />,
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }: any) => {
        if (row.original.status === "PENDING") {
          return (
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                className="text-success border-success/20 hover:bg-success/10"
                onClick={(e) => handleAction(row.original.id, "APPROVED", e)}
                disabled={updateLeave.isPending}
                data-testid={`button-approve-${row.original.id}`}
              >
                <Check className="w-4 h-4" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive border-destructive/20 hover:bg-destructive/10"
                onClick={(e) => handleAction(row.original.id, "REJECTED", e)}
                disabled={updateLeave.isPending}
                data-testid={`button-reject-${row.original.id}`}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          );
        }
        return null;
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Leaves" subtitle="Manage employee leave requests" />

      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList className="bg-surface border w-fit">
          {TABS.map((t) => (
            <TabsTrigger
              key={t}
              value={t}
              className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
              data-testid={`tab-${t.toLowerCase()}`}
            >
              {t === "ALL" ? "All" : t.charAt(0) + t.slice(1).toLowerCase()}
              <Badge variant="secondary" className="ml-2 text-[10px]">{counts[t] || 0}</Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="relative max-w-xs">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by employee..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
          data-testid="input-search-leaves"
        />
      </div>

      <DataTable columns={columns as any} data={filtered} isLoading={isLoading} />
    </div>
  );
}
