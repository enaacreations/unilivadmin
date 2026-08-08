import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-fetch";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { BoundedScroll } from "@/components/ui/bounded-scroll";
import { FoodQueryError } from "@/components/food/query-error";
import { AlertTriangle, ChevronLeft, ChevronRight, Send, Copy, Truck, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/lib/use-permissions";
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SLOTS = ["BREAKFAST", "LUNCH", "SNACK", "DINNER"];
const COLORS = ["var(--primary)", "var(--accent)", "var(--warning)", "var(--info)"];

function mondayOf(d: Date) {
  const x = new Date(d);
  const day = x.getDay();
  x.setDate(x.getDate() - ((day + 6) % 7));
  x.setHours(0, 0, 0, 0);
  return x;
}
const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

export default function MenuPlanning() {
  const { toast } = useToast();
  const qc = useQueryClient();
  // generate-indent is double-gated server-side (MENU_PLANNING:edit AND
  // INDENTS:create), so a MENU_PLANNING holder without the indent grant would
  // otherwise get an armed button that always 403s.
  const { can } = usePermissions();
  const canRaiseIndent = can("INDENTS", "create");
  // M16 — every write on this page goes through MENU_PLANNING create/edit
  // (kitchen.ts menuPlansRouter + productionRouter). PageGuard only checks
  // view, and AUDIT_READONLY holds MENU_PLANNING:view through ALL_MODULES, so
  // without these the whole page — grid cells, Copy, Publish, the production
  // forms — was armed for a principal whose every click 403s.
  const canEditPlan = can("MENU_PLANNING", "edit");
  const canCreatePlan = can("MENU_PLANNING", "create");
  const [indenting, setIndenting] = React.useState(false);
  const [propertyId, setPropertyId] = React.useState<string>("");
  const [weekStart, setWeekStart] = React.useState<Date>(mondayOf(new Date()));
  const [pickerCell, setPickerCell] = React.useState<{ day: number; slot: string } | null>(null);
  const [recipeSearch, setRecipeSearch] = React.useState("");

  // Every query on this page is enabled on propertyId, so a failed property
  // fetch renders the whole page permanently blank. GET /properties carries
  // `authorizeAny(["PROPERTIES", "MENU_PLANNING"], "view")` (properties.ts) for
  // exactly this reason: the page's own personas — kitchen managers and F&B
  // managers — hold MENU_PLANNING and no PROPERTIES cell. The list is still
  // narrowed by resolveAccessiblePropertyIds, so a caller with no scope grant
  // gets an empty array rather than a 403. Surface BOTH outcomes rather than
  // swallow them into an empty week grid.
  const { data: propsRes, isError: propsError, error: propsErr, refetch: refetchProps } = useQuery({
    queryKey: ["properties"],
    queryFn: () => apiFetch<any>("/properties"),
  });
  const properties = propsRes?.data || [];
  React.useEffect(() => { if (!propertyId && properties.length) setPropertyId(properties[0].id); }, [properties, propertyId]);

  const planKey = ["menu-by-week", propertyId, fmtDate(weekStart)];
  const { data: planRes, isError: planError, refetch: refetchPlan } = useQuery({
    queryKey: planKey,
    queryFn: () => apiFetch<any>(`/menu-plans/by-week?propertyId=${propertyId}&weekStart=${weekStart.toISOString()}`),
    enabled: !!propertyId,
  });
  const plan = planRes?.data;
  const slots: Record<string, string> = (plan?.slots as any) || {};
  // Filling a cell PUTs an existing plan but POSTs the first one, so the grid
  // needs whichever grant that week's write will actually use.
  const canSetSlot = plan ? canEditPlan : canCreatePlan;

  // Recipes name every filled cell. A failed read turns a fully planned week
  // into a grid of "—" and an empty recipe picker, neither of which is true.
  const { data: recipesRes, isError: recipesError, refetch: refetchRecipes } = useQuery({ queryKey: ["recipes", "all"], queryFn: () => apiFetch<any>("/recipes?limit=200") });
  const recipes = recipesRes?.data || [];

  const setSlot = async (day: number, slot: string, recipeId: string) => {
    const newSlots = { ...slots, [`${day}-${slot}`]: recipeId };
    try {
      if (plan) {
        await apiFetch(`/menu-plans/${plan.id}`, { method: "PUT", body: JSON.stringify({ slots: newSlots }) });
      } else {
        await apiFetch("/menu-plans", { method: "POST", body: JSON.stringify({ propertyId, weekStart: weekStart.toISOString(), slots: newSlots, status: "DRAFT" }) });
      }
      qc.invalidateQueries({ queryKey: planKey });
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  };

  const onPublish = async () => {
    if (!plan) { toast({ title: "Save first", description: "Add at least one recipe before publishing", variant: "destructive" }); return; }
    try {
      await apiFetch(`/menu-plans/${plan.id}/publish`, { method: "POST" });
      toast({ title: "Menu published — visible to residents" });
      qc.invalidateQueries({ queryKey: planKey });
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  };

  const onCopyLast = async () => {
    if (plan) { toast({ title: "This week already has a plan", variant: "destructive" }); return; }
    try {
      const lastWeek = new Date(weekStart.getTime() - 7 * 86400000);
      const lastRes = await apiFetch<any>(`/menu-plans/by-week?propertyId=${propertyId}&weekStart=${lastWeek.toISOString()}`);
      if (!lastRes?.data) { toast({ title: "No previous week to copy", variant: "destructive" }); return; }
      await apiFetch("/menu-plans/copy", { method: "POST", body: JSON.stringify({ sourcePlanId: lastRes.data.id, propertyId, weekStart: weekStart.toISOString() }) });
      toast({ title: "Last week's plan copied as draft" });
      qc.invalidateQueries({ queryKey: planKey });
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  };

  const onGenerateIndent = async () => {
    if (!plan) { toast({ title: "No plan for this week", variant: "destructive" }); return; }
    // In flight → disabled: the server is idempotent per (plan, week) and now
    // returns the EXISTING draft rather than minting a second one, so the copy
    // says "ready" — three clicks no longer means three procurement documents.
    setIndenting(true);
    try {
      const res = await apiFetch<any>(`/menu-plans/${plan.id}/generate-indent`, { method: "POST", body: JSON.stringify({}) });
      toast({ title: `Indent ${res.data.indentNumber} ready`, description: "Open Procurement → Indents to review." });
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
    finally { setIndenting(false); }
  };

  const recipeName = (id: string) => recipes.find((r: any) => r.id === id)?.name || "—";
  const filteredRecipes = recipes.filter((r: any) =>
    (!pickerCell || r.mealType === pickerCell.slot) &&
    (!recipeSearch || r.name.toLowerCase().includes(recipeSearch.toLowerCase())),
  );

  const weekLabel = `${fmtDate(weekStart)} → ${fmtDate(new Date(weekStart.getTime() + 6 * 86400000))}`;

  return (
    <div className="space-y-6">
      <PageHeader title="Menu Planning" subtitle="Weekly menu, daily production, and analytics" />

      {propsError ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-6 py-10 text-center">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          <p className="text-sm text-destructive">Could not load properties.</p>
          <p className="max-w-md text-[13px] text-muted-foreground">
            {(propsErr as any)?.message || "The property list is required before a week can be planned."}
          </p>
          <Button variant="outline" size="sm" onClick={() => refetchProps()}>Retry</Button>
        </div>
      ) : (
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[200px]">
          <Select value={propertyId} onValueChange={setPropertyId}>
            <SelectTrigger><SelectValue placeholder="Select property" /></SelectTrigger>
            <SelectContent>{properties.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {properties.length === 0 && (
          // Empty is not the same as broken: the list is scoped, so an empty
          // array means this account has no property in its scope. Say so —
          // "no properties" alone reads as "the org has none" and sends the
          // kitchen manager to the wrong person.
          <p className="text-sm text-muted-foreground">
            No properties in your scope — ask an admin to grant you one on Food → Organization → Access.
          </p>
        )}
      </div>
      )}

      <Tabs defaultValue="week">
        <TabsList>
          <TabsTrigger value="week">Week Plan</TabsTrigger>
          <TabsTrigger value="production">Daily Production</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="week" className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * 86400000))}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="font-medium px-2">{weekLabel}</span>
              <Button variant="outline" size="icon" onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * 86400000))}><ChevronRight className="h-4 w-4" /></Button>
              {plan && <Badge variant={plan.status === "PUBLISHED" ? "default" : "outline"}>{plan.status}</Badge>}
            </div>
            <div className="flex gap-2">
              {canCreatePlan && (
                <Button variant="outline" onClick={onCopyLast}><Copy className="h-4 w-4 mr-2" />Copy Last Week</Button>
              )}
              {/* generate-indent is double-gated: MENU_PLANNING:edit AND INDENTS:create. */}
              {canEditPlan && canRaiseIndent && (
                <Button variant="outline" disabled={indenting} onClick={onGenerateIndent}><Truck className="h-4 w-4 mr-2" />{indenting ? "Generating…" : "Generate Indent"}</Button>
              )}
              {canEditPlan && (
                <Button onClick={onPublish}><Send className="h-4 w-4 mr-2" />Publish Menu</Button>
              )}
            </div>
          </div>

          {recipesError && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span className="flex-1">Could not load recipes — planned meals below show as &ldquo;—&rdquo; and the picker is empty.</span>
              <Button variant="outline" size="sm" onClick={() => refetchRecipes()}>Retry</Button>
            </div>
          )}

          {/* A failed plan fetch would otherwise render as an untouched week. */}
          {planError && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span className="flex-1">Could not load this week&rsquo;s plan — the grid below may not reflect what is saved.</span>
              <Button variant="outline" size="sm" onClick={() => refetchPlan()}>Retry</Button>
            </div>
          )}

          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-3 text-sm font-medium text-muted-foreground"></th>
                    {DAYS.map((d, i) => (
                      <th key={d} className="text-left p-3 text-sm font-medium">
                        <div>{d}</div>
                        <div className="text-xs text-muted-foreground font-normal">{fmtDate(new Date(weekStart.getTime() + i * 86400000)).slice(5)}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {SLOTS.map((s) => (
                    <tr key={s} className="border-b">
                      <td className="p-3 text-sm font-medium text-muted-foreground">{s}</td>
                      {DAYS.map((_, di) => {
                        const key = `${di}-${s}`;
                        const rid = slots[key];
                        return (
                          <td key={di} className="p-2 align-top">
                            <button
                              type="button" disabled={!canSetSlot}
                              onClick={() => { setPickerCell({ day: di, slot: s }); setRecipeSearch(""); }}
                              className="w-full text-left p-2 rounded-md border border-dashed border-border transition-colors text-sm min-h-[60px] enabled:hover:border-primary enabled:hover:bg-primary/5 disabled:cursor-default"
                            >
                              {rid ? <span className="font-medium">{recipeName(rid)}</span>
                                : <span className="text-muted-foreground">{canSetSlot ? "Click to add" : "—"}</span>}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="production"><DailyProductionTab propertyId={propertyId} recipes={recipes} slots={slots} canEdit={canEditPlan} /></TabsContent>
        <TabsContent value="analytics"><KitchenAnalyticsTab propertyId={propertyId} /></TabsContent>
      </Tabs>

      <Dialog open={!!pickerCell} onOpenChange={(o) => { if (!o) setPickerCell(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Select recipe — {pickerCell?.slot} on {pickerCell !== null ? DAYS[pickerCell.day] : ""}</DialogTitle></DialogHeader>
          <div className="relative">
            <Search className="h-4 w-4 absolute left-3 top-3 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search recipes..." value={recipeSearch} onChange={(e) => setRecipeSearch(e.target.value)} />
          </div>
          <div className="max-h-[400px] overflow-y-auto space-y-1">
            {filteredRecipes.map((r: any) => (
              <button key={r.id} type="button" onClick={async () => { if (pickerCell) { await setSlot(pickerCell.day, pickerCell.slot, r.id); setPickerCell(null); } }} className="w-full text-left p-3 rounded-md border hover:bg-accent">
                <div className="font-medium">{r.name}</div>
                <div className="text-xs text-muted-foreground">{r.category} · {r.mealType} · {r.isVeg ? "Veg" : "Non-Veg"}</div>
              </button>
            ))}
            {!filteredRecipes.length && (
              <p className="p-4 text-center text-sm text-muted-foreground">
                {recipesError ? "Recipes could not be loaded — close this and retry." : "No matching recipes"}
              </p>
            )}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => { if (pickerCell) { setSlot(pickerCell.day, pickerCell.slot, ""); setPickerCell(null); } }}>Clear cell</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** `canEdit` mirrors POST /daily-production's MENU_PLANNING:edit gate (M16). */
function DailyProductionTab({ propertyId, recipes, slots, canEdit }: { propertyId: string; recipes: any[]; slots: Record<string, string>; canEdit: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);

  // POST /daily-production replaces the WHOLE array for a key, and every writer
  // below builds `[...existing, newRow]` from this read. A failed fetch makes
  // `existing` empty, so one "Add" would wipe today's log instead of appending
  // to it — same invariant as the rotation generator, so the tab refuses to
  // render (and `update` refuses to fire) until the day genuinely loads.
  const { data: prodRes, isError: prodError, isSuccess: prodLoaded, refetch: refetchProd } = useQuery({ queryKey: ["production", propertyId, todayKey], queryFn: () => apiFetch<any>(`/daily-production?propertyId=${propertyId}&date=${todayKey}`), enabled: !!propertyId });
  const prod = prodRes?.data?.[0] || { dispatches: [], wastage: [], receivings: [] };

  const dayIdx = (today.getDay() + 6) % 7;
  const todaysSlots = SLOTS.map((s) => ({ slot: s, recipeId: slots[`${dayIdx}-${s}`] || "" }));

  const update = async (key: "dispatches" | "wastage" | "receivings", arr: any[]) => {
    if (!prodLoaded) {
      toast({ title: "Today's log could not be read", description: "Reload before adding — saving now would overwrite what is already recorded.", variant: "destructive" });
      return;
    }
    try {
      await apiFetch("/daily-production", { method: "POST", body: JSON.stringify({ propertyId, date: today.toISOString(), [key]: arr }) });
      qc.invalidateQueries({ queryKey: ["production", propertyId, todayKey] });
      toast({ title: "Updated" });
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  };

  const dispatches = (prod.dispatches as any[]) || [];
  const wastage = (prod.wastage as any[]) || [];
  const receivings = (prod.receivings as any[]) || [];

  if (prodError) {
    return (
      <FoodQueryError
        label="today's production log"
        hint="An empty log here is indistinguishable from a day nothing has been recorded on, and adding a row would overwrite it."
        onRetry={() => refetchProd()}
      />
    );
  }

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Today's Menu &amp; Dispatch</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {todaysSlots.map((ts) => {
            const r = recipes.find((x) => x.id === ts.recipeId);
            const dispatched = dispatches.find((d) => d.slot === ts.slot);
            return (
              <div key={ts.slot} className="border rounded-md p-3">
                <div className="flex items-center justify-between mb-1">
                  <div><span className="text-xs text-muted-foreground">{ts.slot}</span><div className="font-medium">{r?.name || "Not planned"}</div></div>
                  {dispatched && <Badge>Dispatched · {dispatched.quantity}</Badge>}
                </div>
                {!dispatched && r && canEdit && (
                  <div className="flex gap-2 mt-2">
                    <Input type="number" placeholder="Qty served" className="h-8" id={`q-${ts.slot}`} />
                    <Button size="sm" onClick={() => {
                      const el = document.getElementById(`q-${ts.slot}`) as HTMLInputElement;
                      const q = Number(el?.value || 0);
                      if (!q) return;
                      update("dispatches", [...dispatches, { slot: ts.slot, recipeId: r.id, quantity: q, time: new Date().toISOString() }]);
                    }}>Mark Dispatched</Button>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Wastage Log</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {wastage.length > 0 && (
              <BoundedScroll size="sm">
                <div className="space-y-2 pr-3">
                  {wastage.map((w: any, i: number) => <div key={i} className="text-sm border rounded p-2">{w.item} · {w.quantity} {w.unit} · {w.reason || "—"}</div>)}
                </div>
              </BoundedScroll>
            )}
            {canEdit && <AddRow onAdd={(item, quantity, unit, reason) => update("wastage", [...wastage, { item, quantity: Number(quantity), unit, reason, at: new Date().toISOString() }])} fields={["Item", "Qty", "Unit", "Reason"]} />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Raw Material Receiving</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {receivings.length > 0 && (
              <BoundedScroll size="sm">
                <div className="space-y-2 pr-3">
                  {receivings.map((r: any, i: number) => <div key={i} className="text-sm border rounded p-2">{r.item} · {r.quantity} {r.unit} · expires {r.expiry || "—"}</div>)}
                </div>
              </BoundedScroll>
            )}
            {canEdit && <AddRow onAdd={(item, quantity, unit, expiry) => update("receivings", [...receivings, { item, quantity: Number(quantity), unit, expiry, at: new Date().toISOString() }])} fields={["Item", "Qty", "Unit", "Expiry"]} />}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function AddRow({ onAdd, fields }: { onAdd: (a: string, b: string, c: string, d: string) => void; fields: string[] }) {
  const [v, setV] = React.useState(["", "", "", ""]);
  return (
    <div className="grid grid-cols-5 gap-1 pt-2">
      {[0, 1, 2, 3].map((i) => <Input key={i} placeholder={fields[i]} value={v[i]} onChange={(e) => setV((p) => p.map((x, j) => j === i ? e.target.value : x))} className="h-8 text-xs" />)}
      <Button size="sm" onClick={() => { if (v[0]) { onAdd(v[0], v[1], v[2], v[3]); setV(["", "", "", ""]); } }}>Add</Button>
    </div>
  );
}

function KitchenAnalyticsTab({ propertyId }: { propertyId: string }) {
  // "No feedback yet" / "No wastage logged yet" / "Plan a menu first" are all
  // claims about the kitchen's record. A failed fetch is not evidence for any
  // of them, so each card reports its own failure instead.
  const { data: feedRes, isError: feedError } = useQuery({ queryKey: ["k-feed", propertyId], queryFn: () => apiFetch<any>(`/kitchen-analytics/feedback-trends?propertyId=${propertyId}`), enabled: !!propertyId });
  const { data: wRes, isError: wError } = useQuery({ queryKey: ["k-wast", propertyId], queryFn: () => apiFetch<any>(`/kitchen-analytics/wastage-trends?propertyId=${propertyId}`), enabled: !!propertyId });
  const { data: dRes, isError: dError } = useQuery({ queryKey: ["k-div", propertyId], queryFn: () => apiFetch<any>(`/kitchen-analytics/menu-diversity?propertyId=${propertyId}`), enabled: !!propertyId });
  const feedback = feedRes?.data || [];
  const wastage = wRes?.data || [];
  const diversity = dRes?.data || { veg: 0, nonVeg: 0, special: 0 };
  const divData = [{ name: "Veg", value: diversity.veg }, { name: "Non-Veg", value: diversity.nonVeg }, { name: "Special", value: diversity.special }].filter((d) => d.value > 0);

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Avg Rating by Recipe (last 4 weeks)</CardTitle></CardHeader>
        <CardContent style={{ height: 280 }}>
          {feedback.length ? (
            <ResponsiveContainer width="100%" height="100%"><BarChart data={feedback}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="recipeName" tick={{ fontSize: 10 }} /><YAxis domain={[0, 5]} /><Tooltip /><Bar dataKey="avgRating" fill="var(--primary)" /></BarChart></ResponsiveContainer>
          ) : <p className="text-sm text-muted-foreground">{feedError ? "Could not load feedback." : "No feedback yet"}</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Wastage (kg per week)</CardTitle></CardHeader>
        <CardContent style={{ height: 280 }}>
          {wastage.length ? (
            <ResponsiveContainer width="100%" height="100%"><LineChart data={wastage}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="weekStart" /><YAxis /><Tooltip /><Line type="monotone" dataKey="kg" stroke="var(--primary)" strokeWidth={2} /></LineChart></ResponsiveContainer>
          ) : <p className="text-sm text-muted-foreground">{wError ? "Could not load wastage." : "No wastage logged yet"}</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Menu Diversity</CardTitle></CardHeader>
        <CardContent style={{ height: 280 }}>
          {divData.length ? (
            <ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={divData} dataKey="value" nameKey="name" outerRadius={90} label>{divData.map((_, i) => <Cell key={i} fill={COLORS[i]} />)}</Pie><Tooltip /><Legend /></PieChart></ResponsiveContainer>
          ) : <p className="text-sm text-muted-foreground">{dError ? "Could not load menu diversity." : "Plan a menu first"}</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">At a glance</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex justify-between"><span className="text-muted-foreground text-sm">Recipes used (last 4 weeks)</span><span className="font-medium">{dError ? "—" : (diversity.total || 0)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground text-sm">Avg rating</span><span className="font-medium">{feedback.length ? (feedback.reduce((s: number, x: any) => s + x.avgRating, 0) / feedback.length).toFixed(2) : "—"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground text-sm">Total feedback entries</span><span className="font-medium">{feedError ? "—" : feedback.reduce((s: number, x: any) => s + x.feedbackCount, 0)}</span></div>
        </CardContent>
      </Card>
    </div>
  );
}
