import * as React from "react"
import { useGetEmployee, getGetEmployeeQueryKey } from "@workspace/api-client-react";
import { useParams } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Briefcase, Phone, Mail, Calendar, Building, ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";

export default function EmployeeDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id as string;

  const { data: employeeRes, isLoading } = useGetEmployee(id, { query: { queryKey: getGetEmployeeQueryKey(id), enabled: !!id } });

  const employee = employeeRes?.data;

  if (isLoading) {
    return <div className="space-y-6"><Skeleton className="h-48 w-full" /><Skeleton className="h-96 w-full" /></div>;
  }

  if (!employee) {
    return <div>Employee not found</div>;
  }

  return (
    <div className="space-y-6">
      <Link href="/employees">
        <Button variant="ghost" size="sm" className="mb-2 -ml-2 text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4 mr-1" /> Back to Employees
        </Button>
      </Link>
      
      <div className="flex justify-between items-start">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center text-accent font-display text-2xl font-bold">
            {employee.name.charAt(0)}
          </div>
          <div>
            <h1 className="text-3xl font-display font-bold tracking-tight text-primary">{employee.name}</h1>
            <p className="text-muted-foreground text-sm flex items-center gap-2 mt-1">
              <span className="font-mono bg-muted/20 px-2 py-0.5 rounded text-xs">{employee.employeeCode}</span>
              {employee.designation} · {employee.department}
            </p>
          </div>
        </div>
        <StatusBadge status={employee.status} className="text-sm px-3 py-1" />
      </div>

      <div className="grid gap-6 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
        <Card className="shadow-sm">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-3 bg-primary/5 rounded-full">
              <Phone className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Phone</p>
              <p className="font-medium text-primary mt-0.5">{employee.phone}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-3 bg-primary/5 rounded-full">
              <Mail className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Email</p>
              <p className="font-medium text-primary truncate mt-0.5" title={employee.email}>{employee.email}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-3 bg-primary/5 rounded-full">
              <Calendar className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Joining Date</p>
              <p className="font-medium text-primary mt-0.5">{new Date(employee.joiningDate).toLocaleDateString()}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-3 bg-primary/5 rounded-full">
              <Building className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Location</p>
              <p className="font-medium text-primary mt-0.5">{employee.propertyId ? 'Assigned' : 'HQ'}</p>
            </div>
          </CardContent>
        </Card>
      </div>
      
      <Card className="shadow-sm">
        <CardHeader className="border-b bg-surface/50">
          <CardTitle className="font-display text-base">Attendance Summary</CardTitle>
        </CardHeader>
        <CardContent className="p-8">
          <div className="text-center text-muted-foreground">
            <Calendar className="w-12 h-12 mx-auto text-muted/30 mb-4" />
            <p>Attendance records will be displayed here.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
