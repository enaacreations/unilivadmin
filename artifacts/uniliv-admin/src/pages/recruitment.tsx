import * as React from "react"
import { useGetJobRequisitions, getGetJobRequisitionsQueryKey, useGetCandidates, getGetCandidatesQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";

export default function Recruitment() {
  const { data: reqsRes, isLoading: reqsLoading } = useGetJobRequisitions({ query: { queryKey: getGetJobRequisitionsQueryKey() } });
  const { data: candidatesRes, isLoading: candidatesLoading } = useGetCandidates({ query: { queryKey: getGetCandidatesQueryKey() } });
  
  const requisitions = reqsRes?.data || [];
  const candidates = candidatesRes?.data || [];

  const stages = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'JOINED', 'REJECTED'];

  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-120px)]">
      <PageHeader 
        title="Recruitment" 
        subtitle="Track job requisitions and candidate pipeline"
      />

      <Tabs defaultValue="pipeline" className="flex-1 flex flex-col">
        <TabsList className="bg-surface border w-fit">
          <TabsTrigger value="pipeline" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Candidates Pipeline</TabsTrigger>
          <TabsTrigger value="requisitions" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Job Requisitions</TabsTrigger>
        </TabsList>
        
        <TabsContent value="pipeline" className="flex-1 mt-6 h-full min-h-0">
          {candidatesLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-6 gap-4 h-full">
              {stages.map(s => <Skeleton key={s} className="h-full w-full" />)}
            </div>
          ) : (
            <div className="flex gap-4 overflow-x-auto pb-4 h-full items-start">
              {stages.map(stage => {
                const stageCandidates = candidates.filter(c => c.stage === stage);
                return (
                  <div key={stage} className="min-w-[300px] w-[300px] bg-muted/10 border rounded-lg p-3 flex flex-col max-h-full">
                    <div className="flex justify-between items-center mb-3 px-1">
                      <h3 className="font-display font-semibold text-sm text-primary tracking-tight">{stage}</h3>
                      <Badge variant="secondary" className="bg-card text-xs">{stageCandidates.length}</Badge>
                    </div>
                    <div className="space-y-3 overflow-y-auto pr-1 flex-1 pb-2">
                      {stageCandidates.map(candidate => (
                        <Card key={candidate.id} className="cursor-pointer hover:border-accent/50 transition-colors shadow-sm">
                          <CardContent className="p-3">
                            <p className="font-medium text-sm text-primary">{candidate.name}</p>
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">{candidate.email}</p>
                            {candidate.source && (
                              <Badge variant="outline" className="mt-3 text-[10px] uppercase tracking-wider">{candidate.source}</Badge>
                            )}
                          </CardContent>
                        </Card>
                      ))}
                      {stageCandidates.length === 0 && (
                        <div className="text-center py-6 text-xs text-muted-foreground border border-dashed rounded-lg bg-surface/50">
                          No candidates
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="requisitions" className="mt-6 flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {reqsLoading ? (
              [1, 2, 3].map(i => <Skeleton key={i} className="h-32 w-full" />)
            ) : requisitions.length === 0 ? (
              <div className="col-span-3 text-center py-12 text-muted-foreground border border-dashed rounded-lg bg-surface/50">
                No job requisitions found
              </div>
            ) : (
              requisitions.map(req => (
                <Card key={req.id} className="shadow-sm">
                  <CardHeader className="pb-2 border-b bg-surface/50">
                    <div className="flex justify-between items-start gap-4">
                      <CardTitle className="text-base font-display">{req.role}</CardTitle>
                      <StatusBadge status={req.status} />
                    </div>
                    <p className="text-sm text-muted-foreground">{req.department}</p>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <div className="flex justify-between text-sm items-center">
                      <div className="flex flex-col">
                        <span className="text-xs text-muted-foreground uppercase tracking-wider">Target</span>
                        <span className="font-medium">{req.headcount}</span>
                      </div>
                      <div className="w-px h-8 bg-border"></div>
                      <div className="flex flex-col items-end">
                        <span className="text-xs text-muted-foreground uppercase tracking-wider">Candidates</span>
                        <span className="font-medium">{req.candidateCount}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
