import * as React from "react"
import { useGetRecipes, getGetRecipesQueryKey } from "@workspace/api-client-react";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function Kitchen() {
  const { data: recipesRes, isLoading } = useGetRecipes({ query: { queryKey: getGetRecipesQueryKey() } });
  
  const recipes = recipesRes?.data || [];

  const columns = [
    {
      accessorKey: "name",
      header: "Recipe Name",
      cell: ({ row }: any) => <span className="font-medium text-primary">{row.original.name}</span>
    },
    {
      accessorKey: "category",
      header: "Category",
    },
    {
      accessorKey: "mealType",
      header: "Meal Type",
    },
    {
      accessorKey: "dietary",
      header: "Dietary",
      cell: ({ row }: any) => (
        <Badge variant={row.original.isVeg ? "success" : "destructive"} className="text-[10px] px-2 py-0">
          {row.original.isVeg ? 'VEG' : 'NON-VEG'}
        </Badge>
      )
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }: any) => <StatusBadge status={row.original.isActive ? "ACTIVE" : "INACTIVE"} />
    }
  ];

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Recipes" 
        subtitle="Master recipe database and ingredient lists"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Add Recipe
          </Button>
        }
      />

      <DataTable 
        columns={columns}
        data={recipes}
        isLoading={isLoading}
        searchKey="name"
        searchPlaceholder="Search recipes..."
      />
    </div>
  );
}
