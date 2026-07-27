import { DateTimePicker } from '@workspace/uniliv-admin';

export function Scheduled() {
  return (
    <div className="grid w-80 gap-1.5">
      <label className="text-sm font-medium">Inspection window</label>
      <DateTimePicker value="2026-07-28T09:30" onChange={() => {}} />
    </div>
  );
}

export function Empty() {
  return (
    <div className="grid w-80 gap-1.5">
      <label className="text-sm font-medium">Reminder</label>
      <DateTimePicker value="" onChange={() => {}} placeholder="Pick date & time" />
    </div>
  );
}
