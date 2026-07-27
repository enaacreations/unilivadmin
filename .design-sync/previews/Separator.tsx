import { Separator } from '@workspace/uniliv-admin';

export function Horizontal() {
  return (
    <div className="w-80">
      <div className="space-y-1">
        <h4 className="text-sm font-medium leading-none">Sunrise Residency</h4>
        <p className="text-sm text-muted-foreground">
          Co-living property · 148 rooms
        </p>
      </div>
      <Separator className="my-4" />
      <div className="space-y-1">
        <h4 className="text-sm font-medium leading-none">Facilities team</h4>
        <p className="text-sm text-muted-foreground">
          6 staff · 24h maintenance cover
        </p>
      </div>
    </div>
  );
}

export function Vertical() {
  return (
    <div className="flex h-5 items-center gap-4 text-sm">
      <span>Occupancy</span>
      <Separator orientation="vertical" />
      <span>Complaints</span>
      <Separator orientation="vertical" />
      <span>Audits</span>
      <Separator orientation="vertical" />
      <span>Laundry</span>
    </div>
  );
}
