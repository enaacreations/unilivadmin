import {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Button,
} from '@workspace/uniliv-admin';
import { RefreshCw } from 'lucide-react';

export function SyncOccupancy() {
  return (
    <TooltipProvider>
      <Tooltip open>
        <TooltipTrigger asChild>
          <Button variant="outline" size="icon">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Sync occupancy from PMS</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
