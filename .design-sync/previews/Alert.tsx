import { Alert, AlertTitle, AlertDescription } from '@workspace/uniliv-admin';
import { Info, AlertTriangle, CheckCircle2 } from 'lucide-react';

export function Default() {
  return (
    <Alert className="max-w-md">
      <Info className="h-4 w-4" />
      <AlertTitle>Scheduled maintenance window</AlertTitle>
      <AlertDescription>
        The laundry booking service will be offline on Sunday from 2:00–4:00 AM
        for planned upgrades. Residents will be notified in advance.
      </AlertDescription>
    </Alert>
  );
}

export function Destructive() {
  return (
    <Alert variant="destructive" className="max-w-md">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Fire-safety audit overdue</AlertTitle>
      <AlertDescription>
        Sunrise Residency has missed its quarterly fire-safety inspection.
        Escalate to the property warden to avoid a compliance breach.
      </AlertDescription>
    </Alert>
  );
}

export function Success() {
  return (
    <Alert className="max-w-md border-success/40 text-success [&>svg]:text-success">
      <CheckCircle2 className="h-4 w-4" />
      <AlertTitle>Complaint resolved</AlertTitle>
      <AlertDescription className="text-foreground">
        Ticket #4821 (Room 214 · leaking tap) was closed by the facilities team
        and confirmed by the resident.
      </AlertDescription>
    </Alert>
  );
}
