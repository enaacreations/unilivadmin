import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link } from "wouter";
import { apiFetch } from "@/lib/api-fetch";
import { PageHeader } from "@/components/page-header";
import { FormModal } from "@/components/ui/form-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ControlledDatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatCard } from "@/components/stat-card";
import { Plus, Play, FileText, Layers, BookOpen, GraduationCap, Award, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import jsPDF from "jspdf";

const CATEGORIES = ["Onboarding", "Compliance", "Safety", "Skills", "Leadership", "Customer Service", "Other"];
const ROLES = ["Property Manager", "Front Desk", "Housekeeping", "Security", "Kitchen", "Maintenance", "Sales", "All"];
const TYPES = [
  { v: "VIDEO", icon: Play, label: "Video" },
  { v: "PDF", icon: FileText, label: "PDF" },
  { v: "SCORM", icon: Layers, label: "SCORM" },
];

const schema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  category: z.string().min(1),
  contentType: z.string().min(1),
  contentUrl: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  durationMinutes: z.coerce.number().optional(),
  isMandatory: z.boolean().default(false),
  expiryDate: z.string().optional(),
  passScore: z.coerce.number().default(70),
  targetRoles: z.array(z.string()).default([]),
});

export default function Courses() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [filters, setFilters] = React.useState<{ category?: string; mandatoryOnly?: boolean; targetRole?: string }>({});

  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  if (filters.mandatoryOnly) params.set("mandatoryOnly", "true");
  if (filters.targetRole) params.set("targetRole", filters.targetRole);
  params.set("limit", "200");
  const { data: coursesRes } = useQuery({ queryKey: ["courses", filters], queryFn: () => apiFetch<any>(`/courses?${params}`) });
  const courses = coursesRes?.data || [];

  const { data: statsRes } = useQuery({ queryKey: ["courses-stats"], queryFn: () => apiFetch<any>("/courses/stats") });
  const stats = statsRes?.data;

  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { title: "", category: "Onboarding", contentType: "VIDEO", isMandatory: false, passScore: 70, targetRoles: [] } });

  const onCreate = form.handleSubmit(async (values) => {
    try {
      await apiFetch("/courses", { method: "POST", body: JSON.stringify(values) });
      toast({ title: "Course created" });
      setOpen(false); form.reset({ title: "", category: "Onboarding", contentType: "VIDEO", isMandatory: false, passScore: 70, targetRoles: [] });
      qc.invalidateQueries({ queryKey: ["courses"] });
      qc.invalidateQueries({ queryKey: ["courses-stats"] });
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  });

  const targetRoles = form.watch("targetRoles") || [];
  const toggleRole = (r: string) => form.setValue("targetRoles", targetRoles.includes(r) ? targetRoles.filter((x) => x !== r) : [...targetRoles, r]);

  // No backend certificate endpoint exists, so we render a printable certificate
  // client-side (jsPDF) from the data already returned by /courses/stats.
  const downloadCertificate = (cert: any) => {
    try {
      const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
      const w = doc.internal.pageSize.getWidth();
      const h = doc.internal.pageSize.getHeight();

      // border
      doc.setDrawColor(217, 119, 6); // amber-600
      doc.setLineWidth(3);
      doc.rect(24, 24, w - 48, h - 48);
      doc.setLineWidth(1);
      doc.rect(34, 34, w - 68, h - 68);

      doc.setTextColor(120, 113, 108);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(12);
      doc.text("UNILIV · LEARNING & DEVELOPMENT", w / 2, 96, { align: "center" });

      doc.setTextColor(28, 25, 23);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(34);
      doc.text("Certificate of Completion", w / 2, 150, { align: "center" });

      doc.setFont("helvetica", "normal");
      doc.setFontSize(13);
      doc.setTextColor(120, 113, 108);
      doc.text("This certifies that", w / 2, 200, { align: "center" });

      doc.setFont("helvetica", "bold");
      doc.setFontSize(26);
      doc.setTextColor(217, 119, 6);
      doc.text(`${cert.employeeName || "—"}`, w / 2, 240, { align: "center" });

      doc.setFont("helvetica", "normal");
      doc.setFontSize(12);
      doc.setTextColor(120, 113, 108);
      doc.text(`Employee Code: ${cert.employeeCode || "—"}`, w / 2, 264, { align: "center" });

      doc.setFontSize(13);
      doc.setTextColor(28, 25, 23);
      doc.text("has successfully completed the course", w / 2, 308, { align: "center" });

      doc.setFont("helvetica", "bold");
      doc.setFontSize(20);
      doc.text(`${cert.courseTitle || "—"}`, w / 2, 344, { align: "center" });

      doc.setFont("helvetica", "normal");
      doc.setFontSize(13);
      doc.setTextColor(120, 113, 108);
      const score = cert.score != null ? `${cert.score}%` : "—";
      const dateStr = cert.completedAt ? new Date(cert.completedAt).toLocaleDateString() : "—";
      doc.text(`Score: ${score}    ·    Completed: ${dateStr}`, w / 2, 380, { align: "center" });

      // signature line
      doc.setDrawColor(120, 113, 108);
      doc.setLineWidth(0.8);
      doc.line(w / 2 - 110, h - 80, w / 2 + 110, h - 80);
      doc.setFontSize(11);
      doc.text("Authorised Signatory · Uniliv", w / 2, h - 62, { align: "center" });

      window.open(doc.output("bloburl"), "_blank");
    } catch (e: any) {
      toast({ title: "Could not generate certificate", description: e?.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Learning &amp; Development" subtitle="Courses, enrollments, and compliance" action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-2" />Add Course</Button>} />

      <Tabs defaultValue="library">
        <TabsList>
          <TabsTrigger value="library">Library</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
        </TabsList>

        <TabsContent value="library" className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Select value={filters.category || "ALL"} onValueChange={(v) => setFilters((f) => ({ ...f, category: v === "ALL" ? undefined : v }))}>
              <SelectTrigger className="w-44"><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent><SelectItem value="ALL">All categories</SelectItem>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={filters.targetRole || "ALL"} onValueChange={(v) => setFilters((f) => ({ ...f, targetRole: v === "ALL" ? undefined : v }))}>
              <SelectTrigger className="w-44"><SelectValue placeholder="Role" /></SelectTrigger>
              <SelectContent><SelectItem value="ALL">All roles</SelectItem>{ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
            </Select>
            <Button variant={filters.mandatoryOnly ? "default" : "outline"} size="sm" onClick={() => setFilters((f) => ({ ...f, mandatoryOnly: !f.mandatoryOnly }))}>Mandatory only</Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {courses.map((c: any) => (
              <Link key={c.id} href={`/courses/${c.id}`}>
                <Card className="cursor-pointer hover:border-primary transition-colors h-full">
                  <div className="aspect-video bg-muted rounded-t-lg overflow-hidden flex items-center justify-center">
                    {c.thumbnailUrl ? <img src={c.thumbnailUrl} alt="" className="w-full h-full object-cover" /> : <BookOpen className="h-12 w-12 text-muted-foreground" />}
                  </div>
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-medium">{c.title}</div>
                      {c.isMandatory && <Badge variant="destructive" className="text-[10px]">Mandatory</Badge>}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-xs">{c.category}</Badge>
                      <Badge variant="secondary" className="text-xs">{c.contentType}</Badge>
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground pt-2 border-t">
                      <span>{c.enrollmentCount} enrolled</span>
                      <span>{c.completionRate}% complete</span>
                    </div>
                    {c.expiryDate && <div className="text-[10px] text-muted-foreground">Expires {new Date(c.expiryDate).toLocaleDateString()}</div>}
                  </CardContent>
                </Card>
              </Link>
            ))}
            {!courses.length && <Card className="md:col-span-2 lg:col-span-3"><CardContent className="p-8 text-center text-muted-foreground">No courses yet</CardContent></Card>}
          </div>
        </TabsContent>

        <TabsContent value="reports" className="space-y-4">
          {stats && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <StatCard title="Mandatory Compliance" value={`${stats.mandatoryComplianceRate}%`} icon={GraduationCap} />
                <StatCard title="Mandatory Completed" value={`${stats.mandCompleted} / ${stats.mandTotal}`} icon={Award} />
                <StatCard title="Certificates Issued" value={String(stats.certificates?.length || 0)} icon={Award} />
              </div>
              <Card>
                <CardHeader><CardTitle className="text-base">Completion Rate by Department</CardTitle></CardHeader>
                <CardContent style={{ height: 280 }}>
                  {stats.departmentCompletion?.length ? (
                    <ResponsiveContainer width="100%" height="100%"><BarChart data={stats.departmentCompletion}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="department" tick={{ fontSize: 11 }} /><YAxis domain={[0, 100]} unit="%" /><Tooltip /><Bar dataKey="rate" fill="hsl(var(--primary))" /></BarChart></ResponsiveContainer>
                  ) : <p className="text-sm text-muted-foreground">No data</p>}
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle className="text-base">Certificate Holders</CardTitle></CardHeader>
                <CardContent className="p-0">
                  <table className="w-full">
                    <thead className="border-b text-xs text-muted-foreground"><tr><th className="text-left p-3">Employee</th><th className="text-left p-3">Course</th><th className="text-right p-3">Score</th><th className="text-right p-3">Date</th><th className="p-3"></th></tr></thead>
                    <tbody>
                      {(stats.certificates || []).map((c: any) => (
                        <tr key={c.enrollmentId} className="border-b">
                          <td className="p-3">{c.employeeName} <span className="text-xs text-muted-foreground">({c.employeeCode})</span></td>
                          <td className="p-3">{c.courseTitle}</td>
                          <td className="text-right p-3">{c.score}%</td>
                          <td className="text-right p-3 text-xs">{c.completedAt ? new Date(c.completedAt).toLocaleDateString() : "—"}</td>
                          <td className="p-3"><Button variant="ghost" size="icon" onClick={() => downloadCertificate(c)} title="Download certificate"><Download className="h-4 w-4" /></Button></td>
                        </tr>
                      ))}
                      {!stats.certificates?.length && <tr><td colSpan={5} className="text-center p-6 text-muted-foreground">No certificates yet</td></tr>}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>
      </Tabs>

      <FormModal open={open} onOpenChange={setOpen} title="Add Course" onSave={onCreate}>
        <form className="space-y-3">
          <div><Label>Title *</Label><Input {...form.register("title")} /></div>
          <div><Label>Description</Label><Textarea rows={3} {...form.register("description")} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Category *</Label>
              <Select value={form.watch("category")} onValueChange={(v) => form.setValue("category", v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select>
            </div>
            <div><Label>Content Type *</Label>
              <Select value={form.watch("contentType")} onValueChange={(v) => form.setValue("contentType", v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{TYPES.map((t) => <SelectItem key={t.v} value={t.v}>{t.label}</SelectItem>)}</SelectContent></Select>
            </div>
          </div>
          <div><Label>Target roles</Label>
            <div className="flex flex-wrap gap-2 mt-2">
              {ROLES.map((r) => <button type="button" key={r} onClick={() => toggleRole(r)} className={`px-3 py-1 rounded-full text-xs border ${targetRoles.includes(r) ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border"}`}>{r}</button>)}
            </div>
          </div>
          <div className="flex items-center gap-3"><Switch checked={form.watch("isMandatory")} onCheckedChange={(v) => form.setValue("isMandatory", v)} /><Label>Mandatory</Label></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Duration (minutes)</Label><Input type="number" {...form.register("durationMinutes")} /></div>
            <div><Label>Pass score</Label><Input type="number" {...form.register("passScore")} /></div>
          </div>
          <div><Label>Expiry date</Label><ControlledDatePicker control={form.control} name="expiryDate" /></div>
          <div><Label>Content URL</Label><Input {...form.register("contentUrl")} placeholder="https://... (video / PDF URL)" /></div>
          <div><Label>Thumbnail URL</Label><Input {...form.register("thumbnailUrl")} placeholder="https://..." /></div>
        </form>
      </FormModal>
    </div>
  );
}
