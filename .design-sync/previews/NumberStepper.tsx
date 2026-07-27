import { NumberStepper, Label } from '@workspace/uniliv-admin';

export function Default() {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Label>Quantity received</Label>
      <NumberStepper value={12} onChange={() => {}} min={0} aria-label="Quantity received" />
    </div>
  );
}

export function Spinner() {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Label>Beds per room</Label>
      <NumberStepper value={3} onChange={() => {}} min={1} max={6} spin aria-label="Beds per room" />
    </div>
  );
}

export function WithUnit() {
  return (
    <div className="flex flex-wrap items-end gap-6">
      <div className="grid gap-1.5">
        <Label>Rice ordered</Label>
        <NumberStepper value={25} onChange={() => {}} min={0} unit="kg" aria-label="Rice ordered" />
      </div>
      <div className="grid gap-1.5">
        <Label>Compact (sm)</Label>
        <NumberStepper value={2} onChange={() => {}} min={0} size="sm" aria-label="Compact quantity" />
      </div>
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Label>Locked allocation</Label>
      <NumberStepper value={8} onChange={() => {}} min={0} disabled aria-label="Locked allocation" />
    </div>
  );
}
