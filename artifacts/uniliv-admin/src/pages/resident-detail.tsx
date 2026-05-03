import * as React from "react"
import { useGetResident, getGetResidentQueryKey, useGetResidentLedger, getGetResidentLedgerQueryKey, useGetResidentPayments, getGetResidentPaymentsQueryKey } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Phone, Mail, Building, MapPin, Calendar, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export default function ResidentDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id as string;

  const { data: residentRes, isLoading: residentLoading } = useGetResident(id, { query: { queryKey: getGetResidentQueryKey(id), enabled: !!id } });
  const { data: ledgerRes, isLoading: ledgerLoading } = useGetResidentLedger(id, { query: { queryKey: getGetResidentLedgerQueryKey(id), enabled: !!id } });
  const { data: paymentsRes, isLoading: paymentsLoading } = useGetResidentPayments(id, { query: { queryKey: getGetResidentPaymentsQueryKey(id), enabled: !!id } });

  const resident = residentRes?.data;
  const ledger = ledgerRes?.data || [];
  const payments = paymentsRes?.data || [];

  if (residentLoading) {
    return <div className="space-y-6"><Skeleton className="h-48 w-full" /><Skeleton className="h-96 w-full" /></div>;
  }

  if (!resident) {
    return <div>Resident not found</div>;
  }

  return (
    <div className="space-y-6">
      <Link href="/residents">
        <Button variant="ghost" size="sm" className="mb-2 -ml-2 text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4 mr-1" /> Back to Residents
        </Button>
      </Link>

      <div className="flex justify-between items-start">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center text-accent text-2xl font-display font-bold">
            {resident.name.charAt(0)}
          </div>
          <div>
            <h1 className="text-3xl font-display font-bold tracking-tight text-primary">{resident.name}</h1>
            <div className="flex gap-4 mt-1 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5 bg-surface px-2 py-0.5 rounded"><Phone className="w-3.5 h-3.5" /> {resident.phone}</span>
              <span className="flex items-center gap-1.5 bg-surface px-2 py-0.5 rounded"><Mail className="w-3.5 h-3.5" /> {resident.email}</span>
            </div>
          </div>
        </div>
        <StatusBadge status={resident.status} className="px-3 py-1" />
      </div>

      <div className="grid gap-6 grid-cols-1 md:grid-cols-4">
        <Card className="shadow-sm">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-3 bg-primary/5 rounded-full">
              <Building className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Property</p>
              <p className="font-bold text-primary mt-0.5">{resident.propertyName || 'N/A'}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-3 bg-primary/5 rounded-full">
              <MapPin className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Room</p>
              <p className="font-bold text-primary mt-0.5">{resident.roomNumber || 'N/A'}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-3 bg-primary/5 rounded-full">
              <Calendar className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Check In</p>
              <p className="font-bold text-primary mt-0.5">{resident.checkInDate ? new Date(resident.checkInDate).toLocaleDateString() : 'N/A'}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-3 bg-primary/5 rounded-full font-display font-bold text-xl text-primary flex items-center justify-center">
              ₹
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Monthly Rent</p>
              <p className="font-bold text-primary mt-0.5">{resident.monthlyRent ? `₹${resident.monthlyRent.toLocaleString()}` : 'N/A'}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
        <CardContent className="p-6">
          <Tabs defaultValue="ledger" className="w-full">
            <TabsList className="mb-6 bg-surface">
              <TabsTrigger value="ledger" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground px-6">Ledger</TabsTrigger>
              <TabsTrigger value="payments" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground px-6">Payments</TabsTrigger>
            </TabsList>
            
            <TabsContent value="ledger" className="mt-0">
              <div className="rounded-md border">
                <Table>
                  <TableHeader className="bg-surface/50">
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ledgerLoading ? (
                      <TableRow><TableCell colSpan={5}><Skeleton className="h-10 w-full" /></TableCell></TableRow>
                    ) : ledger.length === 0 ? (
                      <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground border-dashed">No ledger entries</TableCell></TableRow>
                    ) : (
                      ledger.map(entry => (
                        <TableRow key={entry.id}>
                          <TableCell>{new Date(entry.createdAt).toLocaleDateString()}</TableCell>
                          <TableCell><Badge variant="secondary" className="text-xs">{entry.type}</Badge></TableCell>
                          <TableCell className="font-medium text-primary">{entry.description}</TableCell>
                          <TableCell className="font-bold">₹{entry.amount.toLocaleString()}</TableCell>
                          <TableCell>
                            <StatusBadge status={entry.isPaid ? 'PAID' : 'PENDING'} />
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
            
            <TabsContent value="payments" className="mt-0">
              <div className="rounded-md border">
                <Table>
                  <TableHeader className="bg-surface/50">
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Mode</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paymentsLoading ? (
                      <TableRow><TableCell colSpan={5}><Skeleton className="h-10 w-full" /></TableCell></TableRow>
                    ) : payments.length === 0 ? (
                      <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground border-dashed">No payments recorded</TableCell></TableRow>
                    ) : (
                      payments.map(payment => (
                        <TableRow key={payment.id}>
                          <TableCell>{new Date(payment.createdAt).toLocaleDateString()}</TableCell>
                          <TableCell><Badge variant="secondary" className="text-xs uppercase">{payment.mode}</Badge></TableCell>
                          <TableCell className="font-mono text-sm">{payment.reference || '-'}</TableCell>
                          <TableCell className="font-bold text-primary">₹{payment.amount.toLocaleString()}</TableCell>
                          <TableCell>
                            <StatusBadge status={payment.status} />
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
