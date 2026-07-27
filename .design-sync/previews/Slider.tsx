import { Slider, Label } from '@workspace/uniliv-admin';

export function Single() {
  return (
    <div className="w-80">
      <Slider defaultValue={[40]} max={100} step={1} />
    </div>
  );
}

export function Range() {
  return (
    <div className="w-80">
      <Slider defaultValue={[20, 80]} max={100} step={1} />
    </div>
  );
}

export function WithLabels() {
  return (
    <div className="grid gap-6 w-80">
      <div className="grid gap-3">
        <div className="flex items-center justify-between">
          <Label>Occupancy alert threshold</Label>
          <span className="text-sm text-muted-foreground tabular-nums">85%</span>
        </div>
        <Slider defaultValue={[85]} max={100} step={5} />
      </div>
      <div className="grid gap-3">
        <div className="flex items-center justify-between">
          <Label>Monthly rent range</Label>
          <span className="text-sm text-muted-foreground tabular-nums">
            ₹12k – ₹28k
          </span>
        </div>
        <Slider defaultValue={[12, 28]} max={50} step={1} />
      </div>
    </div>
  );
}

export function Disabled() {
  return (
    <div className="w-80">
      <Slider defaultValue={[60]} max={100} step={1} disabled />
    </div>
  );
}
