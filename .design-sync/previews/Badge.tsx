import { Badge } from '@workspace/uniliv-admin';

export function Variants() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>Default</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="destructive">Destructive</Badge>
      <Badge variant="outline">Outline</Badge>
      <Badge variant="success">Success</Badge>
      <Badge variant="warning">Warning</Badge>
      <Badge variant="info">Info</Badge>
    </div>
  );
}

export function RoomStatus() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="success">Occupied</Badge>
      <Badge variant="secondary">Vacant</Badge>
      <Badge variant="warning">Notice period</Badge>
      <Badge variant="info">Under cleaning</Badge>
      <Badge variant="destructive">Maintenance hold</Badge>
    </div>
  );
}

export function TicketStatus() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="destructive">Overdue</Badge>
      <Badge variant="warning">In progress</Badge>
      <Badge variant="info">Awaiting parts</Badge>
      <Badge variant="success">Resolved</Badge>
      <Badge variant="outline">Closed</Badge>
    </div>
  );
}
