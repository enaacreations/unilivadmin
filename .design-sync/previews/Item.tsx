import {
  Item,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemGroup,
  ItemSeparator,
  Button,
  Badge,
  UserAvatar,
} from '@workspace/uniliv-admin';
import { Wrench, ChevronRight } from 'lucide-react';

export function MaintenanceRow() {
  return (
    <Item variant="outline" className="w-96">
      <ItemMedia variant="icon">
        <Wrench />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          Leaking tap · Room 214
          <Badge variant="warning">In progress</Badge>
        </ItemTitle>
        <ItemDescription>
          Reported 2 hours ago · assigned to the facilities team for same-day
          resolution.
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button size="sm" variant="outline">
          Resolve
        </Button>
      </ItemActions>
    </Item>
  );
}

export function ResidentRow() {
  return (
    <Item variant="outline" className="w-96">
      <ItemMedia>
        <UserAvatar name="Priya Nair" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Priya Nair</ItemTitle>
        <ItemDescription>Room 512 · Sunrise Residency · lease ends Mar 2027</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Badge variant="success">Active</Badge>
        <ChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

export function Grouped() {
  return (
    <ItemGroup className="w-96 rounded-lg border">
      <Item>
        <ItemMedia>
          <UserAvatar name="Arjun Mehta" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Arjun Mehta</ItemTitle>
          <ItemDescription>Warden · Sunrise Residency</ItemDescription>
        </ItemContent>
      </Item>
      <ItemSeparator />
      <Item>
        <ItemMedia>
          <UserAvatar name="Fatima Sheikh" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Fatima Sheikh</ItemTitle>
          <ItemDescription>Unit lead · Harbour View</ItemDescription>
        </ItemContent>
      </Item>
    </ItemGroup>
  );
}
