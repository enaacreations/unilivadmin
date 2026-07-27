import { ToggleGroup, ToggleGroupItem } from '@workspace/uniliv-admin';
import {
  AlignLeft,
  AlignCenter,
  AlignRight,
  Bold,
  Italic,
  Underline,
  List,
  LayoutGrid,
  Calendar,
} from 'lucide-react';

export function SingleAlign() {
  return (
    <ToggleGroup type="single" defaultValue="left" variant="outline">
      <ToggleGroupItem value="left" aria-label="Align left">
        <AlignLeft />
      </ToggleGroupItem>
      <ToggleGroupItem value="center" aria-label="Align center">
        <AlignCenter />
      </ToggleGroupItem>
      <ToggleGroupItem value="right" aria-label="Align right">
        <AlignRight />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

export function MultipleFormat() {
  return (
    <ToggleGroup type="multiple" defaultValue={['bold']}>
      <ToggleGroupItem value="bold" aria-label="Bold">
        <Bold />
      </ToggleGroupItem>
      <ToggleGroupItem value="italic" aria-label="Italic">
        <Italic />
      </ToggleGroupItem>
      <ToggleGroupItem value="underline" aria-label="Underline">
        <Underline />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

export function ViewSwitch() {
  return (
    <ToggleGroup type="single" defaultValue="board" variant="outline">
      <ToggleGroupItem value="list" aria-label="List view">
        <List /> List
      </ToggleGroupItem>
      <ToggleGroupItem value="board" aria-label="Board view">
        <LayoutGrid /> Board
      </ToggleGroupItem>
      <ToggleGroupItem value="calendar" aria-label="Calendar view">
        <Calendar /> Calendar
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
