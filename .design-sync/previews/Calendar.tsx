import { Calendar } from '@workspace/uniliv-admin';

export function SingleSelect() {
  return (
    <Calendar
      mode="single"
      selected={new Date(2026, 6, 24)}
      defaultMonth={new Date(2026, 6, 1)}
      className="rounded-md border w-fit"
    />
  );
}

export function RangeSelect() {
  return (
    <Calendar
      mode="range"
      selected={{ from: new Date(2026, 6, 8), to: new Date(2026, 6, 15) }}
      defaultMonth={new Date(2026, 6, 1)}
      className="rounded-md border w-fit"
    />
  );
}
