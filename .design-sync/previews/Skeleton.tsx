import { Skeleton } from '@workspace/uniliv-admin';

export function ResidentCard() {
  return (
    <div className="flex w-80 items-center gap-4 rounded-lg border p-4">
      <Skeleton className="h-12 w-12 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

export function ListRows() {
  return (
    <div className="w-80 space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-md" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function MetricTile() {
  return (
    <div className="w-64 space-y-3 rounded-lg border p-5">
      <Skeleton className="h-3 w-28" />
      <Skeleton className="h-8 w-20" />
      <Skeleton className="h-2 w-full rounded-full" />
    </div>
  );
}
