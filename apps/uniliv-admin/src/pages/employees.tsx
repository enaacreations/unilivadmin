import * as React from "react";
import {
  useGetEmployees,
  getGetEmployeesQueryKey,
  useCreateEmployee,
  useGetProperties,
  getGetPropertiesQueryKey,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Users, UserCheck, UserPlus, UserMinus, Search } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { ControlledDatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { UserAvatar } from "@/components/ui/user-avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { FormModal } from "@/components/ui/form-modal";
import { useToast } from "@/hooks/use-toast";

const DEPARTMENTS = ["Operations", "Housekeeping", "Security", "Kitchen", "Finance", "HR", "Maintenance", "Admin"];

const DESIGNATIONS = [
  "Warden",
  "Property Manager",
  "Operations Manager",
  "Housekeeping Supervisor",
  "Cook",
  "Chef",
  "Kitchen Helper",
  "Security Guard",
  "Maintenance Technician",
  "Electrician",
  "Plumber",
  "Accountant",
  "HR Executive",
  "Sales Executive",
  "Cluster Manager",
  "City Head",
  "Unit Lead",
  "Receptionist",
  "Driver",
  "Caretaker",
];

const empSchema = z.object({
  name: z.string().min(1, "Required"),
  email: z.string().email("Invalid email"),
  phone: z.string().min(7, "Required"),
  dob: z.string().optional(),
  gender: z.string().optional(),
  photo: z.string().optional(),
  department: z.string().min(1, "Required"),
  designation: z.string().min(1, "Required"),
  propertyId: z.string().optional(),
  managerId: z.string().optional(),
  joiningDate: z.string().min(1, "Required"),
  ctc: z.string().optional(),
  basic: z.string().optional(),
  hra: z.string().optional(),
  specialAllowance: z.string().optional(),
  bankAccount: z.string().optional(),
  ifscCode: z.string().optional(),
  panNumber: z.string().optional(),
  pfNumber: z.string().optional(),
  esicNumber: z.string().optional(),
});

type EmpForm = z.infer<typeof empSchema>;

export default function Employees() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [department, setDepartment] = React.useState("ALL");
  const [propertyId, setPropertyId] = React.useState("ALL");
  const [status, setStatus] = React.useState("ALL");
  const [search, setSearch] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);

  const params: Record<string, string> = {};
  if (department !== "ALL") params["department"] = department;
  if (propertyId !== "ALL") params["propertyId"] = propertyId;
  if (status !== "ALL") params["status"] = status;
  if (search) params["search"] = search;

  const { data: empRes, isLoading } = useGetEmployees(params, {
    query: { queryKey: getGetEmployeesQueryKey(params) },
  });
  const employees = empRes?.data || [];

  const { data: propsRes } = useGetProperties(undefined, {
    query: { queryKey: getGetPropertiesQueryKey() },
  });
  const properties = propsRes?.data || [];

  const { data: statsRes } = useQuery({
    queryKey: ["employees-stats"],
    queryFn: () => apiFetch<{ success: boolean; data: { totalActive: number; joinedThisMonth: number; onLeaveToday: number; exitedThisMonth: number } }>("/employees/stats/overview"),
  });
  const stats = statsRes?.data;

  const createMut = useCreateEmployee();

  const form = useForm<EmpForm>({
    resolver: zodResolver(empSchema),
    defaultValues: {
      name: "", email: "", phone: "", dob: "", gender: "", photo: "",
      department: "", designation: "", propertyId: "", managerId: "", joiningDate: "",
      ctc: "", basic: "", hra: "", specialAllowance: "",
      bankAccount: "", ifscCode: "", panNumber: "", pfNumber: "", esicNumber: "",
    },
  });

  const [tab, setTab] = React.useState("personal");

  React.useEffect(() => {
    if (createOpen) {
      form.reset();
      setTab("personal");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createOpen]);

  const onSubmit = form.handleSubmit(async (v) => {
    try {
      const body: Record<string, unknown> = {
        name: v.name, email: v.email, phone: v.phone, department: v.department,
        designation: v.designation, joiningDate: v.joiningDate,
      };
      if (v.dob) body["dob"] = v.dob;
      if (v.gender) body["gender"] = v.gender;
      if (v.photo) body["photo"] = v.photo;
      if (v.propertyId) body["propertyId"] = v.propertyId;
      if (v.managerId) body["managerId"] = v.managerId;
      if (v.ctc) body["ctc"] = Number(v.ctc);
      if (v.basic) body["basic"] = Number(v.basic);
      if (v.hra) body["hra"] = Number(v.hra);
      if (v.specialAllowance) body["specialAllowance"] = Number(v.specialAllowance);
      if (v.bankAccount) body["bankAccount"] = v.bankAccount;
      if (v.ifscCode) body["ifscCode"] = v.ifscCode;
      if (v.panNumber) body["panNumber"] = v.panNumber;
      if (v.pfNumber) body["pfNumber"] = v.pfNumber;
      if (v.esicNumber) body["esicNumber"] = v.esicNumber;
      await createMut.mutateAsync({ data: body as any });
      toast({ title: "Employee created" });
      qc.invalidateQueries({ queryKey: ["employees-stats"] });
      qc.invalidateQueries({ queryKey: getGetEmployeesQueryKey() });
      setCreateOpen(false);
    } catch (e: any) {
      toast({ title: e?.message || "Failed", variant: "destructive" });
    }
  });

  const designationOptions = React.useMemo(() => {
    const seen = new Set<string>();
    const opts: { value: string; label: string }[] = [];
    const add = (raw?: string | null) => {
      const v = (raw || "").trim();
      if (!v) return;
      const key = v.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      opts.push({ value: v, label: v });
    };
    DESIGNATIONS.forEach(add);
    employees.forEach((e) => add(e.designation));
    return opts;
  }, [employees]);

  const propertyName = (id?: string | null) => properties.find((p) => p.id === id)?.name || "—";

  const columns = [
    {
      id: "name",
      header: "Employee",
      accessorKey: "name",
      cell: ({ row }: any) => (
        <div className="flex items-center gap-3">
          <UserAvatar name={row.original.name} src={row.original.photo || undefined} className="h-9 w-9" />
          <div>
            <p className="font-medium text-primary">{row.original.name}</p>
            <p className="text-xs text-muted-foreground">{row.original.email}</p>
          </div>
        </div>
      ),
    },
    {
      accessorKey: "employeeCode",
      header: "Code",
      cell: ({ row }: any) => (
        <span className="font-mono text-xs bg-muted/30 px-2 py-1 rounded">{row.original.employeeCode}</span>
      ),
    },
    {
      accessorKey: "department",
      header: "Department",
      cell: ({ row }: any) => (
        <Badge variant="secondary" className="text-xs uppercase tracking-wider">
          {row.original.department}
        </Badge>
      ),
    },
    { accessorKey: "designation", header: "Designation" },
    {
      id: "property",
      header: "Property",
      cell: ({ row }: any) => <span className="text-sm">{propertyName(row.original.propertyId)}</span>,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }: any) => <StatusBadge status={row.original.status} />,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Employees"
        subtitle="Manage staff across all properties"
        action={
          <Button
            className="bg-accent hover:bg-accent/90 text-white"
            onClick={() => setCreateOpen(true)}
            data-testid="button-add-employee"
          >
            <Plus className="w-4 h-4 mr-2" /> Add Employee
          </Button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total Active" value={stats?.totalActive ?? "—"} icon={UserCheck} />
        <StatCard title="Joined This Month" value={stats?.joinedThisMonth ?? "—"} icon={UserPlus} />
        <StatCard title="On Leave Today" value={stats?.onLeaveToday ?? "—"} icon={Users} />
        <StatCard title="Exited This Month" value={stats?.exitedThisMonth ?? "—"} icon={UserMinus} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={department} onValueChange={setDepartment}>
          <SelectTrigger className="w-44" data-testid="select-filter-department">
            <SelectValue placeholder="Department" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Departments</SelectItem>
            {DEPARTMENTS.map((d) => (
              <SelectItem key={d} value={d}>{d}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={propertyId} onValueChange={setPropertyId}>
          <SelectTrigger className="w-48" data-testid="select-filter-property">
            <SelectValue placeholder="Property" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Properties</SelectItem>
            {properties.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44" data-testid="select-filter-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Status</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="ON_LEAVE">On Leave</SelectItem>
            <SelectItem value="INACTIVE">Inactive</SelectItem>
            <SelectItem value="EXITED">Exited</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search employees..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-search-employees"
          />
        </div>
      </div>

      <DataTable
        columns={columns as any}
        data={employees}
        isLoading={isLoading}
        onRowClick={(row: any) => setLocation(`/employees/${row.id}`)}
      />

      <FormModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Add Employee"
        onSave={onSubmit}
        isSaving={createMut.isPending}
        saveLabel="Create Employee"
      >
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid grid-cols-4 w-full">
            <TabsTrigger value="personal">Personal</TabsTrigger>
            <TabsTrigger value="employment">Employment</TabsTrigger>
            <TabsTrigger value="compensation">Compensation</TabsTrigger>
            <TabsTrigger value="banking">Banking</TabsTrigger>
          </TabsList>

          <TabsContent value="personal" className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label>Name *</Label>
                <Input {...form.register("name")} data-testid="input-name" />
                {form.formState.errors.name && <p className="text-xs text-destructive mt-1">{form.formState.errors.name.message}</p>}
              </div>
              <div>
                <Label>Email *</Label>
                <Input type="email" {...form.register("email")} data-testid="input-email" />
                {form.formState.errors.email && <p className="text-xs text-destructive mt-1">{form.formState.errors.email.message}</p>}
              </div>
              <div>
                <Label>Phone *</Label>
                <Input type="tel" inputMode="numeric" maxLength={10} placeholder="10-digit number" {...form.register("phone")} data-testid="input-phone" />
                {form.formState.errors.phone && <p className="text-xs text-destructive mt-1">{form.formState.errors.phone.message}</p>}
              </div>
              <div>
                <Label>Date of Birth</Label>
                <ControlledDatePicker control={form.control} name="dob" />
              </div>
              <div>
                <Label>Gender</Label>
                <Select value={form.watch("gender") || ""} onValueChange={(v) => form.setValue("gender", v)}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Male">Male</SelectItem>
                    <SelectItem value="Female">Female</SelectItem>
                    <SelectItem value="Other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2">
                <Label>Photo URL</Label>
                <Input {...form.register("photo")} placeholder="https://..." />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="employment" className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Department *</Label>
                <Select value={form.watch("department") || ""} onValueChange={(v) => form.setValue("department", v)}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {DEPARTMENTS.map((d) => (<SelectItem key={d} value={d}>{d}</SelectItem>))}
                  </SelectContent>
                </Select>
                {form.formState.errors.department && <p className="text-xs text-destructive mt-1">{form.formState.errors.department.message}</p>}
              </div>
              <div>
                <Label>Designation *</Label>
                <Combobox
                  options={designationOptions}
                  value={form.watch("designation") || ""}
                  onChange={(v) =>
                    form.setValue("designation", v || "", {
                      shouldValidate: true,
                      shouldDirty: true,
                    })
                  }
                  creatable
                  placeholder="Select or type a designation"
                  searchPlaceholder="Search or add designation…"
                />
                {form.formState.errors.designation && <p className="text-xs text-destructive mt-1">{form.formState.errors.designation.message}</p>}
              </div>
              <div>
                <Label>Property</Label>
                <Select value={form.watch("propertyId") || ""} onValueChange={(v) => form.setValue("propertyId", v)}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {properties.map((p) => (<SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Manager</Label>
                <Select value={form.watch("managerId") || ""} onValueChange={(v) => form.setValue("managerId", v)}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {employees.filter((e) => e.status === "ACTIVE").map((e) => (
                      <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2">
                <Label>Joining Date *</Label>
                <ControlledDatePicker control={form.control} name="joiningDate" />
                {form.formState.errors.joiningDate && <p className="text-xs text-destructive mt-1">{form.formState.errors.joiningDate.message}</p>}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="compensation" className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>CTC (Annual)</Label>
                <InputGroup>
                  <InputGroupAddon>₹</InputGroupAddon>
                  <InputGroupInput type="number" inputMode="numeric" min={0} placeholder="0" {...form.register("ctc")} />
                </InputGroup>
              </div>
              <div>
                <Label>Basic</Label>
                <InputGroup>
                  <InputGroupAddon>₹</InputGroupAddon>
                  <InputGroupInput type="number" inputMode="numeric" min={0} placeholder="0" {...form.register("basic")} />
                </InputGroup>
              </div>
              <div>
                <Label>HRA</Label>
                <InputGroup>
                  <InputGroupAddon>₹</InputGroupAddon>
                  <InputGroupInput type="number" inputMode="numeric" min={0} placeholder="0" {...form.register("hra")} />
                </InputGroup>
              </div>
              <div>
                <Label>Special Allowance</Label>
                <InputGroup>
                  <InputGroupAddon>₹</InputGroupAddon>
                  <InputGroupInput type="number" inputMode="numeric" min={0} placeholder="0" {...form.register("specialAllowance")} />
                </InputGroup>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="banking" className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Bank Account</Label>
                <Input
                  inputMode="numeric"
                  maxLength={18}
                  placeholder="Account number"
                  {...form.register("bankAccount")}
                />
              </div>
              <div>
                <Label>IFSC Code</Label>
                <Input
                  maxLength={11}
                  placeholder="ABCD0123456"
                  pattern="[A-Za-z]{4}0[A-Za-z0-9]{6}"
                  className="uppercase"
                  {...form.register("ifscCode", {
                    onChange: (e) => { e.target.value = e.target.value.toUpperCase(); },
                  })}
                />
              </div>
              <div>
                <Label>PAN Number</Label>
                <Input
                  maxLength={10}
                  placeholder="ABCDE1234F"
                  pattern="[A-Za-z]{5}[0-9]{4}[A-Za-z]{1}"
                  className="uppercase"
                  {...form.register("panNumber", {
                    onChange: (e) => { e.target.value = e.target.value.toUpperCase(); },
                  })}
                />
              </div>
              <div>
                <Label>PF Number</Label>
                <Input
                  maxLength={22}
                  placeholder="UAN / PF number"
                  className="uppercase"
                  {...form.register("pfNumber", {
                    onChange: (e) => { e.target.value = e.target.value.toUpperCase(); },
                  })}
                />
              </div>
              <div className="col-span-2">
                <Label>ESIC Number</Label>
                <Input
                  inputMode="numeric"
                  maxLength={17}
                  placeholder="17-digit IP number"
                  {...form.register("esicNumber")}
                />
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </FormModal>
    </div>
  );
}
