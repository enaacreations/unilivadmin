import * as React from "react"
import { Search, Download, Settings2, PackageX } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  getPaginationRowModel,
  getSortedRowModel,
  SortingState,
  getFilteredRowModel,
  ColumnFiltersState,
  VisibilityState,
} from "@tanstack/react-table"

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  searchKey?: string
  searchPlaceholder?: string
  isLoading?: boolean
  onRowClick?: (row: TData) => void
  toolbarActions?: React.ReactNode
  /** Filename (without extension) for the built-in CSV export. */
  exportFilename?: string
  /** Hide the built-in Export button. */
  hideExport?: boolean
  /**
   * Caps the height of the scrollable table body so pages stop long-scrolling.
   * The toolbar stays pinned above and the pagination footer stays pinned below;
   * only the rows scroll, beneath a sticky header. Accepts any CSS length
   * (e.g. "58vh", "480px"). Pass `false` to disable bounding and let the table
   * grow to its natural height. Defaults to `"58vh"`.
   */
  maxBodyHeight?: string | false
}

export function DataTable<TData, TValue>({
  columns,
  data,
  searchKey,
  searchPlaceholder = "Search...",
  isLoading = false,
  onRowClick,
  toolbarActions,
  exportFilename = "export",
  hideExport = false,
  maxBodyHeight = "58vh",
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = React.useState({})

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    onColumnFiltersChange: setColumnFilters,
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
    },
  })

  // Client-side CSV export of the currently filtered rows + visible data columns.
  const exportCsv = React.useCallback(() => {
    // Only accessor columns (skip display/action columns, which have no value).
    const cols = table.getVisibleLeafColumns().filter((c) => {
      const def = c.columnDef as { accessorKey?: unknown; accessorFn?: unknown }
      return (def.accessorKey != null || def.accessorFn != null) && c.id !== "select"
    })
    const headerText = (c: typeof cols[number]): string => {
      const h = c.columnDef.header
      return typeof h === "string" ? h : c.id
    }
    const cellText = (v: unknown): string => {
      if (v === null || v === undefined) return ""
      if (Array.isArray(v)) return v.join("; ")
      if (typeof v === "object") return JSON.stringify(v)
      return String(v)
    }
    const escape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
    const rows = table.getFilteredRowModel().rows
    const lines = [
      cols.map((c) => escape(headerText(c))).join(","),
      ...rows.map((r) => cols.map((c) => escape(cellText(r.getValue(c.id)))).join(",")),
    ]
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${exportFilename}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }, [table, exportFilename])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center flex-1 space-x-2">
          {searchKey && (
            <div className="relative max-w-sm w-full">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={searchPlaceholder}
                value={(table.getColumn(searchKey)?.getFilterValue() as string) ?? ""}
                onChange={(event) =>
                  table.getColumn(searchKey)?.setFilterValue(event.target.value)
                }
                className="pl-9"
              />
            </div>
          )}
          {toolbarActions}
        </div>
        <div className="flex items-center space-x-2">
          {!hideExport && (
            <Button variant="outline" size="sm" className="hidden lg:flex" onClick={exportCsv} disabled={isLoading || data.length === 0}>
              <Download className="mr-2 h-4 w-4" />
              Export
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Settings2 className="mr-2 h-4 w-4" />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {table
                .getAllColumns()
                .filter(
                  (column) => column.getCanHide()
                )
                .map((column) => {
                  return (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      className="capitalize"
                      checked={column.getIsVisible()}
                      onCheckedChange={(value) =>
                        column.toggleVisibility(!!value)
                      }
                    >
                      {column.id}
                    </DropdownMenuCheckboxItem>
                  )
                })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      
      <div className="rounded-md border bg-card">
        {/*
          Scroll region. The base <Table> wraps itself in its own
          `overflow-auto` div; we flatten that to `overflow-visible`
          (`[&>div]:overflow-visible`) so THIS div is the single scroll parent.
          That matters because a `sticky` <thead> sticks to its nearest
          scroll-clipping ancestor — we want it sticking to this height-capped
          container, not the inner wrapper. Horizontal overflow always works;
          vertical height is capped at `maxBodyHeight` unless it's `false`.
          `overscroll-contain` keeps wheel momentum from bubbling to the page.
        */}
        <div
          className={cn(
            "w-full [&>div]:overflow-visible",
            maxBodyHeight !== false
              ? "overflow-auto overscroll-contain"
              : "overflow-x-auto"
          )}
          style={maxBodyHeight !== false ? { maxHeight: maxBodyHeight } : undefined}
        >
          <Table>
            <TableHeader
              className={cn(
                maxBodyHeight !== false &&
                  "sticky top-0 z-10 bg-card [&_tr]:border-b [&_tr]:border-border"
              )}
            >
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    return (
                      <TableHead key={header.id}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(
                              header.column.columnDef.header,
                              header.getContext()
                            )}
                      </TableHead>
                    )
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, index) => (
                <TableRow key={index}>
                  {columns.map((column, cellIndex) => (
                    <TableCell key={cellIndex}>
                      <Skeleton className="h-6 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  className={onRowClick ? "cursor-pointer hover:bg-muted/50" : ""}
                  onClick={() => onRowClick && onRowClick(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  <div className="flex flex-col items-center justify-center text-muted-foreground py-8">
                    <PackageX className="h-8 w-8 mb-2" />
                    <p>No results found.</p>
                  </div>
                </TableCell>
              </TableRow>
            )}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="flex items-center justify-between px-2">
        <div className="flex-1 text-sm text-muted-foreground">
          {table.getFilteredSelectedRowModel().rows.length} of{" "}
          {table.getFilteredRowModel().rows.length} row(s) selected.
        </div>
        <div className="flex items-center space-x-6 lg:space-x-8">
          <div className="flex items-center space-x-2">
            <p className="text-sm font-medium">Rows per page</p>
            <Select
              value={`${table.getState().pagination.pageSize}`}
              onValueChange={(value) => {
                table.setPageSize(Number(value))
              }}
            >
              <SelectTrigger className="h-8 w-[70px]">
                <SelectValue placeholder={table.getState().pagination.pageSize} />
              </SelectTrigger>
              <SelectContent side="top">
                {[10, 20, 30, 40, 50].map((pageSize) => (
                  <SelectItem key={pageSize} value={`${pageSize}`}>
                    {pageSize}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex w-[100px] items-center justify-center text-sm font-medium">
            Page {table.getState().pagination.pageIndex + 1} of{" "}
            {table.getPageCount() || 1}
          </div>
          <div className="flex items-center space-x-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              Next
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
