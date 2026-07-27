import { DatePicker } from '@workspace/uniliv-admin';

export function SelectedDate() {
  return (
    <div className="grid w-64 gap-1.5">
      <label className="text-sm font-medium">Move-in date</label>
      <DatePicker value="2026-07-20" onChange={() => {}} />
    </div>
  );
}

export function Placeholder() {
  return (
    <div className="grid w-64 gap-1.5">
      <label className="text-sm font-medium">Lease end date</label>
      <DatePicker value="" onChange={() => {}} placeholder="Pick a date" />
    </div>
  );
}

export function Clearable() {
  return (
    <div className="grid w-64 gap-1.5">
      <label className="text-sm font-medium">Inspection due</label>
      <DatePicker value="2026-08-05" onChange={() => {}} clearable />
    </div>
  );
}
