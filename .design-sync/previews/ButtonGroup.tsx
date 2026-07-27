import {
  ButtonGroup,
  ButtonGroupText,
  ButtonGroupSeparator,
  Button,
} from '@workspace/uniliv-admin';
import { List, LayoutGrid, Map } from 'lucide-react';

export function ViewToggle() {
  return (
    <ButtonGroup>
      <Button variant="secondary" size="sm">
        <List className="h-4 w-4" />
        List
      </Button>
      <Button variant="outline" size="sm">
        <LayoutGrid className="h-4 w-4" />
        Grid
      </Button>
      <Button variant="outline" size="sm">
        <Map className="h-4 w-4" />
        Map
      </Button>
    </ButtonGroup>
  );
}

export function LabelledGroup() {
  return (
    <ButtonGroup>
      <ButtonGroupText>Occupancy</ButtonGroupText>
      <ButtonGroupSeparator />
      <Button variant="outline" size="sm">
        Day
      </Button>
      <Button variant="secondary" size="sm">
        Week
      </Button>
      <Button variant="outline" size="sm">
        Month
      </Button>
    </ButtonGroup>
  );
}
