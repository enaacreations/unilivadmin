import * as React from "react";
import { useGetRecipes, getGetRecipesQueryKey, useCreateRecipe, useUpdateRecipe, useDeleteRecipe } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { FormModal } from "@/components/ui/form-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, Pencil, Leaf, Drumstick } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const ALLERGENS = ["Gluten", "Dairy", "Nuts", "Egg", "Soy", "Seafood", "None"];
const CATEGORIES = ["Breakfast", "Lunch", "Snack", "Dinner", "Beverage"];
const MEAL_TYPES = ["BREAKFAST", "LUNCH", "SNACK", "DINNER"];
const UNITS = ["g", "kg", "ml", "L", "pcs", "tsp", "tbsp", "cup"];

const ingredientSchema = z.object({
  name: z.string().min(1, "Required"),
  quantity: z.coerce.number().min(0.01, "Required"),
  unit: z.string().min(1, "Required"),
  vendorSupplied: z.boolean().default(false),
});

const recipeSchema = z.object({
  name: z.string().min(1, "Required"),
  category: z.string().min(1, "Required"),
  mealType: z.string().min(1, "Required"),
  isVeg: z.boolean().default(true),
  allergens: z.array(z.string()).default([]),
  ingredients: z.array(ingredientSchema).min(1, "Add at least 1 ingredient"),
  method: z.string().optional(),
  photoUrl: z.string().optional(),
});
type RecipeForm = z.infer<typeof recipeSchema>;

export default function Kitchen() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState<string>("ALL");
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<any>(null);

  const params = { ...(search ? { search } : {}), ...(categoryFilter !== "ALL" ? { category: categoryFilter } : {}) };
  const { data, isLoading } = useGetRecipes(params, { query: { queryKey: getGetRecipesQueryKey(params) } });
  const recipes = (data as any)?.data || [];
  const create = useCreateRecipe();
  const update = useUpdateRecipe();
  const del = useDeleteRecipe();

  const form = useForm<RecipeForm>({
    resolver: zodResolver(recipeSchema),
    defaultValues: { name: "", category: "Breakfast", mealType: "BREAKFAST", isVeg: true, allergens: [], ingredients: [{ name: "", quantity: 0, unit: "g", vendorSupplied: false }], method: "", photoUrl: "" },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "ingredients" });

  const openNew = () => { setEditing(null); form.reset({ name: "", category: "Breakfast", mealType: "BREAKFAST", isVeg: true, allergens: [], ingredients: [{ name: "", quantity: 0, unit: "g", vendorSupplied: false }], method: "", photoUrl: "" }); setOpen(true); };
  const openEdit = (r: any) => { setEditing(r); form.reset({ name: r.name, category: r.category, mealType: r.mealType, isVeg: r.isVeg, allergens: r.allergens || [], ingredients: r.ingredients?.length ? r.ingredients : [{ name: "", quantity: 0, unit: "g", vendorSupplied: false }], method: r.method || "", photoUrl: r.photoUrl || "" }); setOpen(true); };

  const onSave = form.handleSubmit(async (values) => {
    try {
      if (editing) await update.mutateAsync({ id: editing.id, data: values as any });
      else await create.mutateAsync({ data: values as any });
      toast({ title: editing ? "Recipe updated" : "Recipe created" });
      setOpen(false);
      qc.invalidateQueries({ queryKey: getGetRecipesQueryKey() });
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  });

  const onDelete = async (id: string) => {
    if (!confirm("Delete this recipe?")) return;
    try {
      await del.mutateAsync({ id });
      toast({ title: "Recipe deleted" });
      qc.invalidateQueries({ queryKey: getGetRecipesQueryKey() });
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); }
  };

  const columns = [
    { accessorKey: "name", header: "Recipe", cell: ({ row }: any) => (
      <div className="flex items-center gap-2">
        {row.original.isVeg ? <Leaf className="h-4 w-4 text-green-600" /> : <Drumstick className="h-4 w-4 text-red-600" />}
        <span className="font-medium text-primary">{row.original.name}</span>
      </div>
    )},
    { accessorKey: "category", header: "Category" },
    { accessorKey: "mealType", header: "Meal", cell: ({ row }: any) => <Badge variant="outline">{row.original.mealType}</Badge> },
    { accessorKey: "allergens", header: "Allergens", cell: ({ row }: any) => (
      <div className="flex flex-wrap gap-1">{(row.original.allergens || []).slice(0, 3).map((a: string) => <Badge key={a} variant="secondary" className="text-xs">{a}</Badge>)}</div>
    )},
    { id: "actions", header: "", cell: ({ row }: any) => (
      <div className="flex gap-1">
        <Button variant="ghost" size="icon" onClick={() => openEdit(row.original)}><Pencil className="h-4 w-4" /></Button>
        <Button variant="ghost" size="icon" onClick={() => onDelete(row.original.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
      </div>
    )},
  ];

  const allergens = form.watch("allergens") || [];
  const toggleAllergen = (a: string) => {
    const next = allergens.includes(a) ? allergens.filter((x) => x !== a) : [...allergens, a];
    form.setValue("allergens", next);
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Recipes" subtitle="Master recipe library for kitchen operations" action={<Button onClick={openNew}><Plus className="h-4 w-4 mr-2" />Add Recipe</Button>} />
      <div className="flex gap-3">
        <Input placeholder="Search recipes..." value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All categories</SelectItem>
            {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <DataTable columns={columns} data={recipes} isLoading={isLoading} />
      <FormModal open={open} onOpenChange={setOpen} title={editing ? "Edit Recipe" : "Add Recipe"} onSave={onSave} isSaving={create.isPending || update.isPending}>
        <form className="space-y-4">
          <div><Label>Name *</Label><Input {...form.register("name")} />{form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}</div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Category *</Label>
              <Select value={form.watch("category")} onValueChange={(v) => form.setValue("category", v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select>
            </div>
            <div><Label>Meal Type *</Label>
              <Select value={form.watch("mealType")} onValueChange={(v) => form.setValue("mealType", v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{MEAL_TYPES.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent></Select>
            </div>
          </div>
          <div className="flex items-center gap-3"><Switch checked={form.watch("isVeg")} onCheckedChange={(v) => form.setValue("isVeg", v)} /><Label>Vegetarian</Label></div>
          <div>
            <Label>Allergens</Label>
            <div className="flex flex-wrap gap-2 mt-2">
              {ALLERGENS.map((a) => (
                <button type="button" key={a} onClick={() => toggleAllergen(a)} className={`px-3 py-1 rounded-full text-xs border ${allergens.includes(a) ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border"}`}>{a}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-2"><Label>Ingredients *</Label><Button type="button" size="sm" variant="outline" onClick={() => append({ name: "", quantity: 0, unit: "g", vendorSupplied: false })}><Plus className="h-3 w-3 mr-1" />Add</Button></div>
            <div className="space-y-2">
              {fields.map((f, i) => (
                <div key={f.id} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-5"><Input placeholder="Name" {...form.register(`ingredients.${i}.name`)} /></div>
                  <div className="col-span-2"><Input type="number" step="any" placeholder="Qty" {...form.register(`ingredients.${i}.quantity`)} /></div>
                  <div className="col-span-2">
                    <Select value={form.watch(`ingredients.${i}.unit`)} onValueChange={(v) => form.setValue(`ingredients.${i}.unit`, v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent></Select>
                  </div>
                  <div className="col-span-2 flex items-center gap-1"><Switch checked={form.watch(`ingredients.${i}.vendorSupplied`)} onCheckedChange={(v) => form.setValue(`ingredients.${i}.vendorSupplied`, v)} /><span className="text-xs">Vendor</span></div>
                  <div className="col-span-1"><Button type="button" variant="ghost" size="icon" onClick={() => remove(i)}><Trash2 className="h-4 w-4" /></Button></div>
                </div>
              ))}
            </div>
            {form.formState.errors.ingredients && <p className="text-xs text-destructive mt-1">{form.formState.errors.ingredients.message as string}</p>}
          </div>
          <div><Label>Preparation Method</Label><Textarea rows={4} {...form.register("method")} /></div>
          <div><Label>Photo URL</Label><Input {...form.register("photoUrl")} placeholder="https://..." /></div>
        </form>
      </FormModal>
    </div>
  );
}
