import * as React from "react"
import { Search, Download, Settings2, PackageX, FileText, FileDown, ChevronDown } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { jsPDF } from "jspdf"
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
  /** Filename (without extension) for the built-in CSV/PDF export. */
  exportFilename?: string
  /** Hide the built-in Export button. */
  hideExport?: boolean
  /**
   * WS11: opt into offering both CSV and PDF from the built-in Export control.
   * Default "csv" keeps the legacy single-button (CSV-only) behaviour so
   * existing tables are unaffected; "csv+pdf" turns it into a dropdown.
   */
  exportFormats?: "csv" | "csv+pdf"
  /** Title rendered at the top of the exported PDF (defaults to exportFilename). */
  exportTitle?: string
  /** Property name embedded in the PDF/CSV header + the dated filename. */
  exportPropertyName?: string | null
  /**
   * Caps the height of the scrollable table body so pages stop long-scrolling.
   * The toolbar stays pinned above and the pagination footer stays pinned below;
   * only the rows scroll, beneath a sticky header. Accepts any CSS length
   * (e.g. "58vh", "480px"). Pass `false` to disable bounding and let the table
   * grow to its natural height. Defaults to `"58vh"`.
   */
  maxBodyHeight?: string | false
  /**
   * localStorage key (sans prefix) under which the Columns picker's visibility
   * choices persist. When omitted, a stable key is derived from the page path
   * (record ids stripped) plus the table's column ids — so every table gets
   * persistence per logical table without wiring a key at each call site.
   */
  columnsStorageKey?: string
}

const COLUMNS_STORE_PREFIX = "uniliv_table_columns_"

const colId = (c: ColumnDef<unknown, unknown>): string =>
  String(c.id ?? (c as { accessorKey?: unknown }).accessorKey ?? "")

/** Stable per-table identity: pathname with id-like segments (uuids / numbers)
 *  stripped, plus the column-id signature — distinguishes multiple tables on
 *  one page while sharing one key across all records of a detail page. */
function deriveColumnsKey(columns: ColumnDef<unknown, unknown>[]): string {
  const path = window.location.pathname
    .split("/")
    .filter(Boolean)
    .filter((seg) => !/^\d+$/.test(seg) && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg))
    .join("/")
  const sig = columns.map(colId).filter(Boolean).join(",")
  return `${path}::${sig}`
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
  exportFormats = "csv",
  exportTitle,
  exportPropertyName = null,
  maxBodyHeight = "58vh",
  columnsStorageKey,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const storageKey =
    COLUMNS_STORE_PREFIX +
    (columnsStorageKey ?? deriveColumnsKey(columns as ColumnDef<unknown, unknown>[]))
  // Columns-picker choices persist in the browser, per table (see storageKey).
  // Entries are validated against the current column ids so renamed/removed
  // columns never resurrect stale state.
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return {}
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
      const valid = new Set(
        (columns as ColumnDef<unknown, unknown>[]).map(colId).filter(Boolean),
      )
      return Object.fromEntries(
        Object.entries(parsed).filter(([k, v]) => valid.has(k) && typeof v === "boolean"),
      ) as VisibilityState
    } catch {
      return {}
    }
  })
  React.useEffect(() => {
    try {
      // Default visibility is "shown", so only `false` entries carry meaning —
      // persisting just those lets the key disappear once a table is back to
      // its default column set.
      const hidden = Object.fromEntries(
        Object.entries(columnVisibility).filter(([, v]) => v === false),
      )
      if (Object.keys(hidden).length === 0) localStorage.removeItem(storageKey)
      else localStorage.setItem(storageKey, JSON.stringify(hidden))
    } catch { /* storage unavailable — persistence is best-effort */ }
  }, [columnVisibility, storageKey])
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

  // Build the export matrix (headers + display-text rows) from the currently
  // filtered rows and visible data columns.
  //
  // WS11 bug fix: previously the CSV used `row.getValue(col.id)`, which returns
  // the RAW accessor value — so a column keyed on `propertyId` (but rendered via
  // a `cell` that looks up the property name) exported the id, not the name. We
  // now render each column's `cell` and extract its display text, falling back
  // to the raw value only when there is no custom renderer. This resolves any
  // id-like column to whatever the table actually shows on screen.
  const buildMatrix = React.useCallback((): { headers: string[]; rows: string[][] } => {
    const cols = table.getVisibleLeafColumns().filter((c) => {
      const def = c.columnDef as { accessorKey?: unknown; accessorFn?: unknown }
      return (def.accessorKey != null || def.accessorFn != null) && c.id !== "select"
    })
    const headerText = (c: typeof cols[number]): string => {
      const h = c.columnDef.header
      return typeof h === "string" ? h : c.id
    }
    const rows = table.getFilteredRowModel().rows
    const matrix = rows.map((r) =>
      r.getVisibleCells()
        .filter((cell) => cols.some((c) => c.id === cell.column.id))
        .map((cell) => {
          const def = cell.column.columnDef as { cell?: unknown }
          // Prefer the rendered cell's display text (resolves id→name, formatted
          // dates, badge labels). Fall back to the raw accessor value.
          if (typeof def.cell === "function") {
            const rendered = (def.cell as (ctx: unknown) => React.ReactNode)(cell.getContext())
            const text = reactToText(rendered).trim()
            if (text) return text
          }
          return rawToText(cell.getValue())
        }),
    )
    return { headers: cols.map(headerText), rows: matrix }
  }, [table])

  const exportCsv = React.useCallback(() => {
    const { headers, rows } = buildMatrix()
    const escape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
    const exportDate = new Date()
    const title = exportTitle ?? exportFilename
    const meta: string[] = [title]
    if (exportPropertyName) meta.push(`Property: ${exportPropertyName}`)
    meta.push(`Exported: ${fmtDateTime(exportDate)}`)
    const lines = [
      ...meta.map(escape),
      "",
      headers.map(escape).join(","),
      ...rows.map((r) => r.map(escape).join(",")),
    ]
    downloadBlob(
      new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" }),
      `${exportFilename}-${fileDateStamp(exportDate)}.csv`,
    )
  }, [buildMatrix, exportFilename, exportTitle, exportPropertyName])

  const exportPdf = React.useCallback(() => {
    const { headers, rows } = buildMatrix()
    const exportDate = new Date()
    const title = exportTitle ?? exportFilename
    const pdf = renderPdf({ title, headers, rows, propertyName: exportPropertyName, exportDate })
    downloadBlob(pdf, `${exportFilename}-${fileDateStamp(exportDate)}.pdf`)
  }, [buildMatrix, exportFilename, exportTitle, exportPropertyName])

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
          {!hideExport && exportFormats === "csv+pdf" ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="hidden lg:flex" disabled={isLoading || data.length === 0}>
                  <Download className="mr-2 h-4 w-4" />
                  Export
                  <ChevronDown className="ml-2 h-4 w-4 opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuLabel>Export</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={exportCsv}>
                  <FileDown className="mr-2 h-4 w-4 text-muted-foreground" /> CSV
                </DropdownMenuItem>
                <DropdownMenuItem onClick={exportPdf}>
                  <FileText className="mr-2 h-4 w-4 text-destructive" /> PDF
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : !hideExport ? (
            <Button variant="outline" size="sm" className="hidden lg:flex" onClick={exportCsv} disabled={isLoading || data.length === 0}>
              <Download className="mr-2 h-4 w-4" />
              Export
            </Button>
          ) : null}
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

/* ── Export helpers (WS11) ──────────────────────────────────────────────────── */

const pad = (n: number) => String(n).padStart(2, "0")

/** yyyy-MM-dd stamp for filenames. */
function fileDateStamp(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** dd/MM/yyyy HH:mm — human-readable timestamp for the document header. */
function fmtDateTime(d: Date): string {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Convert a raw accessor value to display text. */
function rawToText(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (Array.isArray(v)) return v.join("; ")
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

/**
 * Recursively extract visible text from a rendered React node. Used so exports
 * mirror what the table displays (e.g. a property NAME rendered from a
 * propertyId accessor, a formatted date, or a status-badge label).
 */
function reactToText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(reactToText).join("")
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode; status?: unknown; value?: unknown; label?: unknown }
    const childText = reactToText(props.children)
    if (childText) return childText
    // Leaf components that carry their text in a prop rather than children
    // (e.g. <StatusBadge status="DELIVERED" />).
    if (props.status != null) return String(props.status)
    if (props.value != null) return rawToText(props.value)
    if (props.label != null) return String(props.label)
    return ""
  }
  return ""
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Minimal client-side PDF table via jsPDF (no autotable dependency). */
function renderPdf(opts: {
  title: string
  headers: string[]
  rows: string[][]
  propertyName?: string | null
  exportDate: Date
}): Blob {
  const { title, headers, rows, propertyName, exportDate } = opts
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const margin = 36
  const usableW = pageW - margin * 2
  const cols = Math.max(1, headers.length)
  const colW = usableW / cols
  const rowH = 18
  const fontSize = 8

  const fit = (text: string, width: number): string => {
    let s = text ?? ""
    while (s.length > 0 && doc.getTextWidth(s) > width - 6) s = s.slice(0, -1)
    return s.length < (text ?? "").length ? s.slice(0, -1) + "…" : s
  }

  let y = margin

  const drawTitle = () => {
    doc.setFont("helvetica", "bold")
    doc.setFontSize(14)
    doc.setTextColor(15, 23, 42)
    doc.text(title, margin, y + 10)
    doc.setDrawColor(250, 115, 22)
    doc.setLineWidth(3)
    doc.line(margin, y + 16, margin + 48, y + 16)
    y += 28
    const metaParts: string[] = []
    if (propertyName) metaParts.push(`Property: ${propertyName}`)
    metaParts.push(`Exported: ${fmtDateTime(exportDate)}`)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.setTextColor(107, 114, 128)
    doc.text(metaParts.join("    "), margin, y + 4)
    y += 18
  }

  const drawHeader = () => {
    doc.setFillColor(15, 23, 42)
    doc.rect(margin, y, usableW, rowH, "F")
    doc.setFont("helvetica", "bold")
    doc.setFontSize(fontSize)
    doc.setTextColor(255, 255, 255)
    headers.forEach((h, i) => {
      doc.text(fit(h, colW), margin + i * colW + 4, y + 12)
    })
    y += rowH
  }

  doc.setFontSize(fontSize)
  drawTitle()
  drawHeader()

  doc.setFont("helvetica", "normal")
  rows.forEach((row, idx) => {
    if (y + rowH > pageH - margin) {
      doc.addPage()
      y = margin
      drawHeader()
      doc.setFont("helvetica", "normal")
    }
    if (idx % 2 === 0) {
      doc.setFillColor(245, 250, 252)
      doc.rect(margin, y, usableW, rowH, "F")
    }
    doc.setFontSize(fontSize)
    doc.setTextColor(26, 31, 41)
    row.forEach((cell, i) => {
      doc.text(fit(cell ?? "", colW), margin + i * colW + 4, y + 12)
    })
    y += rowH
  })

  return doc.output("blob")
}
