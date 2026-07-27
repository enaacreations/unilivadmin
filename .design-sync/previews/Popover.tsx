import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Button,
  Badge,
} from '@workspace/uniliv-admin';
import { SlidersHorizontal } from 'lucide-react';

export function FilterRooms() {
  return (
    <Popover open>
      <PopoverTrigger asChild>
        <Button variant="outline">
          <SlidersHorizontal className="mr-2 h-4 w-4" />
          Filters
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="grid gap-3">
          <div className="grid gap-1">
            <p className="text-sm font-semibold leading-none">Filter rooms</p>
            <p className="text-xs text-muted-foreground">Sunrise Residency</p>
          </div>
          <div className="grid gap-2">
            <p className="text-xs font-medium text-muted-foreground">Status</p>
            <div className="flex flex-wrap gap-1.5">
              <Badge>Occupied</Badge>
              <Badge variant="secondary">Vacant</Badge>
              <Badge variant="outline">Under repair</Badge>
            </div>
          </div>
          <div className="flex items-center justify-between pt-1">
            <Button variant="ghost" size="sm">
              Reset
            </Button>
            <Button size="sm">Apply</Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
