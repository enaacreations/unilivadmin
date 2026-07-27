import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  Button,
} from '@workspace/uniliv-admin';
import { ClipboardList, Plus, Inbox } from 'lucide-react';

export function NoAudits() {
  return (
    <Empty className="w-96 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ClipboardList />
        </EmptyMedia>
        <EmptyTitle>No audits yet</EmptyTitle>
        <EmptyDescription>
          Create your first inspection to start tracking compliance across your
          properties.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button>
          <Plus /> New audit
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export function EmptyQueue() {
  return (
    <Empty className="w-96 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox />
        </EmptyMedia>
        <EmptyTitle>Review queue is clear</EmptyTitle>
        <EmptyDescription>
          There are no complaints waiting for review in this property. New
          tickets will appear here automatically.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
