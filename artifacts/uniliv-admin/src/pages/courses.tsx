import * as React from "react"
import { useGetCourses, getGetCoursesQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { BookOpen, Users, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export default function Courses() {
  const { data: coursesRes, isLoading } = useGetCourses({ query: { queryKey: getGetCoursesQueryKey() } });
  
  const courses = coursesRes?.data || [];

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Learning & Development" 
        subtitle="Manage training modules and track employee compliance"
        action={
          <Button className="bg-accent hover:bg-accent/90 text-white">
            <Plus className="w-4 h-4 mr-2" />
            Create Course
          </Button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        {isLoading ? (
          Array.from({length: 8}).map((_, i) => <Skeleton key={i} className="h-[200px] w-full rounded-xl" />)
        ) : courses.length === 0 ? (
          <div className="col-span-full text-center py-16 text-muted-foreground border border-dashed rounded-xl bg-surface/50">
            No courses found
          </div>
        ) : (
          courses.map((course) => (
            <Card key={course.id} className="flex flex-col overflow-hidden group hover:border-accent/50 transition-colors shadow-sm">
              <div className="h-2 bg-primary"></div>
              <CardHeader className="pb-3 pt-5">
                <div className="flex justify-between items-start gap-2 mb-2">
                  <Badge variant="secondary" className="bg-surface text-xs uppercase tracking-wider">{course.category}</Badge>
                  {course.isMandatory && <StatusBadge status="CRITICAL" className="px-2 py-0 text-[10px]">MANDATORY</StatusBadge>}
                </div>
                <CardTitle className="text-lg leading-tight font-display text-primary group-hover:text-accent transition-colors line-clamp-2">
                  {course.title}
                </CardTitle>
              </CardHeader>
              <CardContent className="mt-auto pt-4 flex justify-between items-center text-sm text-muted-foreground border-t bg-surface/30">
                <div className="flex items-center gap-1.5 font-medium">
                  <BookOpen className="w-4 h-4 text-primary/50" />
                  {course.contentType}
                </div>
                <div className="flex items-center gap-1.5 font-medium">
                  <Users className="w-4 h-4 text-primary/50" />
                  {course.enrollmentCount} Enrolled
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
