import { Progress } from '@workspace/uniliv-admin';

export function Values() {
  return (
    <div className="w-80 space-y-4">
      <Progress value={24} />
      <Progress value={62} />
      <Progress value={100} />
    </div>
  );
}

export function AuditCompletion() {
  return (
    <div className="w-80 space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">Q3 fire-safety audit</span>
        <span className="text-muted-foreground">18 / 24 checks</span>
      </div>
      <Progress value={75} />
      <p className="text-xs text-muted-foreground">6 items still pending review</p>
    </div>
  );
}

export function OccupancyBreakdown() {
  return (
    <div className="w-80 space-y-3">
      <div className="space-y-1">
        <div className="flex justify-between text-sm">
          <span>Sunrise Residency</span>
          <span className="text-muted-foreground">92%</span>
        </div>
        <Progress value={92} />
      </div>
      <div className="space-y-1">
        <div className="flex justify-between text-sm">
          <span>Harbour View</span>
          <span className="text-muted-foreground">78%</span>
        </div>
        <Progress value={78} />
      </div>
      <div className="space-y-1">
        <div className="flex justify-between text-sm">
          <span>Metro Nest</span>
          <span className="text-muted-foreground">45%</span>
        </div>
        <Progress value={45} />
      </div>
    </div>
  );
}
