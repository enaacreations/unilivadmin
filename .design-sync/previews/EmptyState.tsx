import { EmptyState, Button } from '@workspace/uniliv-admin';
import { Wrench, Users, Plus } from 'lucide-react';

export function NoTickets() {
  return (
    <EmptyState
      className="w-96"
      icon={Wrench}
      title="No open maintenance tickets"
      description="Every reported issue in this property has been resolved. New tickets from residents will show up here."
      action={
        <Button>
          <Plus /> Raise a ticket
        </Button>
      }
    />
  );
}

export function NoResidents() {
  return (
    <EmptyState
      className="w-96"
      icon={Users}
      title="No residents assigned"
      description="This block doesn't have any residents yet. Invite residents or import them from a spreadsheet to get started."
    />
  );
}
