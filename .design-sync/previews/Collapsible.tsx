import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  Button,
  Badge,
} from '@workspace/uniliv-admin';
import { ChevronsUpDown } from 'lucide-react';

export function FilterPanel() {
  return (
    <Collapsible defaultOpen className="w-full max-w-sm space-y-2">
      <div className="flex items-center justify-between rounded-md border px-4 py-2">
        <div className="text-sm font-medium">Active filters</div>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="w-9 p-0">
            <ChevronsUpDown className="h-4 w-4" />
            <span className="sr-only">Toggle filters</span>
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="space-y-2">
        <div className="flex items-center justify-between rounded-md border px-4 py-2 text-sm">
          <span className="text-muted-foreground">Property</span>
          <Badge variant="secondary">Sunrise Residency</Badge>
        </div>
        <div className="flex items-center justify-between rounded-md border px-4 py-2 text-sm">
          <span className="text-muted-foreground">Status</span>
          <Badge variant="warning">Needs review</Badge>
        </div>
        <div className="flex items-center justify-between rounded-md border px-4 py-2 text-sm">
          <span className="text-muted-foreground">Template</span>
          <Badge variant="info">Fire &amp; Safety</Badge>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
