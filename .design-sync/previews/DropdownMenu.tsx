import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  Button,
} from '@workspace/uniliv-admin';
import { Eye, Pencil, UserPlus, Download, Trash2 } from 'lucide-react';

export function RowActions() {
  return (
    <DropdownMenu open>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Room 214 · Priya Nair</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <Eye />
          View details
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Pencil />
          Edit tenancy
        </DropdownMenuItem>
        <DropdownMenuItem>
          <UserPlus />
          Reassign warden
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <Download />
          Export record
          <DropdownMenuShortcut>⌘E</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive focus:text-destructive">
          <Trash2 />
          Remove resident
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
