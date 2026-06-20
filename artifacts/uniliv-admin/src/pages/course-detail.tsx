import * as React from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { ArrowLeft, BellRing, UserPlus, Play, FileText, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function CourseDetail() {
  const [, params] = useRoute("/courses/:id");
  const id = params?.id || "";
  const qc = useQueryClient();
  const { toast } = useToast();
  const [enrollOpen, setEnrollOpen] = React.useState(false);
  const [viewerEnrollment, setViewerEnrollment] = React.useState<any>(null);

  const { data: courseRes } = useQuery({ queryKey: ["course", id], queryFn: () => apiFetch<any>(`/courses/${id}`), enabled: !!id });
  const { data: enrRes } = useQuery({ queryKey: ["course-enr", id], queryFn: () => apiFetch<any>(`/courses/${id}/enrollments`), enabled: !!id });
  const course = courseRes?.data;
  const enrollments = enrRes?.data || [];

  const sendReminders = async () => {
    try {
      const res = await apiFetch<any>(`/courses/${id}/remind`, { method: "POST" });
      toast({ title: `Reminders sent to ${res.data.sent} employee(s)` });
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  };

  if (!course) return <div className="p-8 text-muted-foreground">Loading...</div>;

  const completionPct = course.completionRate || 0;
  const c = (n: number) => `${(n * 251.2 / 100).toFixed(0)}`;

  return (
    <div className="space-y-6">
      <Link href="/courses"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" />Back</Button></Link>
      <PageHeader title={course.title} subtitle={course.description || course.category} action={
        <div className="flex gap-2">
          <Button variant="outline" onClick={sendReminders}><BellRing className="h-4 w-4 mr-2" />Send Reminder</Button>
          <Button onClick={() => setEnrollOpen(true)}><UserPlus className="h-4 w-4 mr-2" />Enroll Employees</Button>
        </div>
      } />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card><CardContent className="p-6 flex items-center gap-3"><Badge variant="outline">{course.category}</Badge><Badge variant="secondary">{course.contentType}</Badge>{course.isMandatory && <Badge variant="destructive">Mandatory</Badge>}</CardContent></Card>
        <Card><CardContent className="p-6"><div className="text-xs text-muted-foreground">Enrolled</div><div className="text-2xl font-medium">{course.enrollmentCount}</div></CardContent></Card>
        <Card><CardContent className="p-6 flex items-center gap-4">
          <svg width="64" height="64" viewBox="0 0 80 80" className="-rotate-90"><circle cx="40" cy="40" r="32" stroke="var(--border)" strokeWidth="10" fill="none" /><circle cx="40" cy="40" r="32" stroke="var(--accent)" strokeWidth="10" fill="none" strokeDasharray={`${c(completionPct)} 999`} /></svg>
          <div><div className="text-xs text-muted-foreground">Completion</div><div className="text-2xl font-medium">{completionPct}%</div></div>
        </CardContent></Card>
      </div>

      <Tabs defaultValue="enrollments">
        <TabsList><TabsTrigger value="enrollments">Enrollments</TabsTrigger><TabsTrigger value="content">Content</TabsTrigger></TabsList>

        <TabsContent value="enrollments">
          <Card>
            <CardContent className="p-0">
              <table className="w-full">
                <thead className="border-b text-xs text-muted-foreground"><tr><th className="text-left p-3">Employee</th><th className="text-left p-3">Department</th><th className="text-left p-3">Progress</th><th className="text-right p-3">Score</th><th className="text-center p-3">Status</th><th className="p-3"></th></tr></thead>
                <tbody>
                  {enrollments.map((en: any) => (
                    <tr key={en.id} className="border-b">
                      <td className="p-3">{en.employee?.name || "—"} <span className="text-xs text-muted-foreground">({en.employee?.employeeCode})</span></td>
                      <td className="p-3">{en.employee?.department || "—"}</td>
                      <td className="p-3 w-48"><div className="flex items-center gap-2"><Progress value={en.progress || 0} className="h-2" /><span className="text-xs w-10">{Math.round(en.progress || 0)}%</span></div></td>
                      <td className="text-right p-3">{en.score != null ? `${en.score}%` : "—"}</td>
                      <td className="text-center p-3">{en.completed ? <Badge>Completed</Badge> : <Badge variant="outline">In progress</Badge>}</td>
                      <td className="p-3"><Button size="sm" variant="ghost" onClick={() => setViewerEnrollment(en)}>Open</Button></td>
                    </tr>
                  ))}
                  {!enrollments.length && <tr><td colSpan={6} className="text-center p-8 text-muted-foreground">No enrollments yet — click "Enroll Employees" to add</td></tr>}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="content">
          <Card>
            <CardHeader><CardTitle className="text-base">Course Content</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex gap-2 items-center">{course.contentType === "VIDEO" ? <Play className="h-4 w-4" /> : <FileText className="h-4 w-4" />}<span className="text-muted-foreground">Type:</span> {course.contentType}</div>
              <div><span className="text-muted-foreground">URL:</span> <a href={course.contentUrl || "#"} className="text-primary underline" target="_blank" rel="noreferrer">{course.contentUrl || "Not set"}</a></div>
              <div><span className="text-muted-foreground">Pass score:</span> {course.passScore || 70}%</div>
              {course.durationMinutes && <div><span className="text-muted-foreground">Duration:</span> {course.durationMinutes} min</div>}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {enrollOpen && <EnrollDialog courseId={id} onClose={() => setEnrollOpen(false)} onDone={() => { qc.invalidateQueries({ queryKey: ["course", id] }); qc.invalidateQueries({ queryKey: ["course-enr", id] }); }} existingIds={new Set(enrollments.map((e: any) => e.employeeId))} />}
      {viewerEnrollment && <ContentViewer course={course} enrollment={viewerEnrollment} onClose={() => setViewerEnrollment(null)} onProgress={() => qc.invalidateQueries({ queryKey: ["course-enr", id] })} />}
    </div>
  );
}

function EnrollDialog({ courseId, onClose, onDone, existingIds }: { courseId: string; onClose: () => void; onDone: () => void; existingIds: Set<string> }) {
  const { toast } = useToast();
  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [deptFilter, setDeptFilter] = React.useState("");

  const { data } = useQuery({ queryKey: ["employees-all"], queryFn: () => apiFetch<any>("/employees?limit=500") });
  const employees = (data?.data || []).filter((e: any) =>
    !existingIds.has(e.id) &&
    (!search || e.name.toLowerCase().includes(search.toLowerCase())) &&
    (!deptFilter || e.department === deptFilter),
  );
  const departments = Array.from(new Set((data?.data || []).map((e: any) => e.department))).filter(Boolean);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSelected((s) => s.size === employees.length ? new Set() : new Set(employees.map((e: any) => e.id)));

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Enroll Employees</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input placeholder="Search employees..." value={search} onChange={(e) => setSearch(e.target.value)} />
            <Select value={deptFilter || "ALL"} onValueChange={(v) => setDeptFilter(v === "ALL" ? "" : v)}>
              <SelectTrigger className="w-48"><SelectValue placeholder="All departments" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All departments</SelectItem>
                {(departments as string[]).map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={toggleAll} size="sm">{selected.size === employees.length && employees.length > 0 ? "None" : "All"}</Button>
          </div>
          <div className="max-h-[400px] overflow-y-auto border rounded">
            {employees.map((e: any) => (
              <label key={e.id} className="flex items-center gap-3 p-2 border-b hover:bg-accent cursor-pointer">
                <Checkbox checked={selected.has(e.id)} onCheckedChange={() => toggle(e.id)} />
                <div className="flex-1">
                  <div className="text-sm font-medium">{e.name}</div>
                  <div className="text-xs text-muted-foreground">{e.department} · {e.role} · {e.employeeCode}</div>
                </div>
              </label>
            ))}
            {!employees.length && <p className="text-sm p-4 text-muted-foreground text-center">No matching employees</p>}
          </div>
        </div>
        <DialogFooter>
          <span className="text-sm text-muted-foreground mr-auto">{selected.size} selected</span>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={async () => {
            if (!selected.size) return;
            try {
              const res = await apiFetch<any>(`/courses/${courseId}/enroll`, { method: "POST", body: JSON.stringify({ employeeIds: Array.from(selected) }) });
              toast({ title: `${res.data.created} enrolled`, description: res.data.skipped ? `${res.data.skipped} already enrolled` : undefined });
              onClose(); onDone();
            } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
          }}>Enroll {selected.size}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ContentViewer({ course, enrollment, onClose, onProgress }: { course: any; enrollment: any; onClose: () => void; onProgress: () => void }) {
  const { data: meRes } = useQuery({ queryKey: ["me"], queryFn: () => apiFetch<any>("/auth/me") });
  const user = meRes?.data;
  const { toast } = useToast();
  const [progress, setProgress] = React.useState<number>(enrollment.progress || 0);
  const [showQuiz, setShowQuiz] = React.useState(false);

  const updateProgress = async (p: number) => {
    setProgress(p);
    try {
      await apiFetch(`/enrollments/${enrollment.id}/progress`, { method: "POST", body: JSON.stringify({ progress: p }) });
      if (p >= 80) toast({ title: "Marked complete!" });
      onProgress();
    } catch { /* progress updates fire frequently; avoid toast spam */ }
  };

  const watermark = `${user?.name || "User"} · ${user?.id?.slice(0, 8) || ""}`;

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader><DialogTitle className="flex items-center justify-between"><span>{course.title}</span><Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button></DialogTitle></DialogHeader>
        <div className="relative">
          <div className="absolute top-2 right-2 z-10 bg-black/60 text-white text-[10px] px-2 py-1 rounded pointer-events-none">{watermark}</div>
          <div className="absolute bottom-2 left-2 z-10 bg-black/60 text-white text-[10px] px-2 py-1 rounded pointer-events-none">{watermark}</div>

          {course.contentType === "VIDEO" && course.contentUrl ? (
            <video
              src={course.contentUrl}
              controls
              controlsList="nodownload"
              onContextMenu={(e) => e.preventDefault()}
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                const pct = Math.min(100, Math.round((v.currentTime / v.duration) * 100));
                if (pct > progress + 5 || pct >= 80) updateProgress(pct);
                if (v.playbackRate > 1.5) v.playbackRate = 1.5;
              }}
              onRateChange={(e) => { if (e.currentTarget.playbackRate > 1.5) e.currentTarget.playbackRate = 1.5; }}
              className="w-full rounded"
              style={{ maxHeight: "60vh" }}
            />
          ) : course.contentType === "PDF" && course.contentUrl ? (
            <div onScroll={(e) => {
              const el = e.currentTarget;
              const pct = Math.min(100, Math.round(((el.scrollTop + el.clientHeight) / el.scrollHeight) * 100));
              if (pct >= 95) updateProgress(100);
              else if (pct > progress + 5) updateProgress(pct);
            }} className="overflow-y-auto" style={{ height: "60vh" }}>
              <iframe src={`${course.contentUrl}#toolbar=0&navpanes=0`} className="w-full" style={{ height: "200vh" }} title="pdf" />
            </div>
          ) : <div className="p-8 text-center text-muted-foreground">No content URL configured</div>}
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <Progress value={progress} className="flex-1" />
            <span className="font-medium w-12 text-right">{progress}%</span>
            {enrollment.completed && <Badge>Completed</Badge>}
          </div>
          {course.quiz?.questions?.length > 0 && <Button onClick={() => setShowQuiz(true)} disabled={progress < 80}>Take Quiz</Button>}
        </div>

        {showQuiz && <QuizDialog course={course} enrollmentId={enrollment.id} onClose={() => setShowQuiz(false)} onDone={() => { setShowQuiz(false); onProgress(); }} />}
      </DialogContent>
    </Dialog>
  );
}

function QuizDialog({ course, enrollmentId, onClose, onDone }: { course: any; enrollmentId: string; onClose: () => void; onDone: () => void }) {
  const questions = (course.quiz?.questions || []) as Array<{ q: string; options: string[]; correctIdx: number }>;
  const [answers, setAnswers] = React.useState<Record<number, number>>({});
  const [result, setResult] = React.useState<any>(null);
  const { toast } = useToast();

  const submit = async () => {
    try {
      const res = await apiFetch<any>(`/enrollments/${enrollmentId}/quiz`, { method: "POST", body: JSON.stringify({ answers }) });
      setResult(res.data);
      if (res.data.passed) toast({ title: `Passed — ${res.data.score}%` });
      else toast({ title: `Did not pass — ${res.data.score}%`, description: `Need ${res.data.passScore}%`, variant: "destructive" });
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  };

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>Quiz — {course.title}</DialogTitle></DialogHeader>
        {!result ? (
          <div className="space-y-4 max-h-[60vh] overflow-y-auto">
            {questions.map((q, i) => (
              <div key={i} className="space-y-2">
                <div className="font-medium text-sm">{i + 1}. {q.q}</div>
                <RadioGroup
                  value={answers[i] != null ? String(answers[i]) : ""}
                  onValueChange={(v) => setAnswers({ ...answers, [i]: Number(v) })}
                >
                  {q.options.map((o, oi) => (
                    <label key={oi} htmlFor={`q-${i}-${oi}`} className="flex items-center gap-2 p-2 border rounded cursor-pointer hover:bg-accent">
                      <RadioGroupItem id={`q-${i}-${oi}`} value={String(oi)} />
                      <span className="text-sm">{o}</span>
                    </label>
                  ))}
                </RadioGroup>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center space-y-3 p-6">
            <div className={`text-4xl font-bold ${result.passed ? "text-green-600" : "text-destructive"}`}>{result.score}%</div>
            <div className={result.passed ? "text-green-700" : "text-destructive"}>{result.passed ? "Passed" : `Need ${result.passScore}% to pass`}</div>
            <div className="text-sm text-muted-foreground">{result.correctAnswers} / {result.totalQuestions} correct</div>
          </div>
        )}
        <DialogFooter>
          {!result ? <><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={Object.keys(answers).length !== questions.length}>Submit</Button></>
            : <><Button variant="outline" onClick={() => { setResult(null); setAnswers({}); }} disabled={result.passed}>Retake</Button><Button onClick={onDone}>Close</Button></>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
