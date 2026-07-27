import { TimePicker } from '@workspace/uniliv-admin';

export function CutOffTime() {
  return (
    <div className="grid w-56 gap-1.5">
      <label className="text-sm font-medium">Dinner cut-off</label>
      <TimePicker value="21:00" onChange={() => {}} />
    </div>
  );
}

export function Empty() {
  return (
    <div className="grid w-56 gap-1.5">
      <label className="text-sm font-medium">Service start</label>
      <TimePicker value="" onChange={() => {}} placeholder="Select time" />
    </div>
  );
}
