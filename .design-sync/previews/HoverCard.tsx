import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
  Button,
  Avatar,
  AvatarFallback,
} from '@workspace/uniliv-admin';
import { MapPin, CalendarDays } from 'lucide-react';

export function ResidentProfile() {
  return (
    <HoverCard open>
      <HoverCardTrigger asChild>
        <Button variant="link" className="px-0">
          @priya.nair
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72">
        <div className="flex gap-3">
          <Avatar className="h-11 w-11">
            <AvatarFallback className="bg-accent/12 text-accent-strong font-medium">
              PN
            </AvatarFallback>
          </Avatar>
          <div className="grid gap-1">
            <p className="text-sm font-semibold leading-none">Priya Nair</p>
            <p className="text-xs text-muted-foreground">Resident · Room 214</p>
            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <MapPin className="h-3.5 w-3.5" />
              Sunrise Residency, Koramangala
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" />
              Joined March 2024
            </div>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
