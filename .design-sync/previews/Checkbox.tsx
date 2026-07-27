import { Checkbox, Label } from '@workspace/uniliv-admin';

export function States() {
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="flex items-center gap-2">
        <Checkbox id="c-off" />
        <Label htmlFor="c-off">Unchecked</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="c-on" defaultChecked />
        <Label htmlFor="c-on">Checked</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="c-dis" disabled />
        <Label htmlFor="c-dis">Disabled</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="c-dis-on" disabled defaultChecked />
        <Label htmlFor="c-dis-on">Disabled checked</Label>
      </div>
    </div>
  );
}

export function AmenityChecklist() {
  return (
    <div className="grid gap-3 w-72">
      <div className="flex items-center gap-2">
        <Checkbox id="a-wifi" defaultChecked />
        <Label htmlFor="a-wifi">High-speed WiFi</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="a-house" defaultChecked />
        <Label htmlFor="a-house">Daily housekeeping</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="a-laundry" />
        <Label htmlFor="a-laundry">In-house laundry</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="a-meals" />
        <Label htmlFor="a-meals">Meals included</Label>
      </div>
    </div>
  );
}

export function WithDescription() {
  return (
    <div className="flex items-start gap-2 w-80">
      <Checkbox id="c-desc" defaultChecked className="mt-0.5" />
      <div className="grid gap-1">
        <Label htmlFor="c-desc">Fire-safety inspection passed</Label>
        <p className="text-sm text-muted-foreground">
          Extinguishers and smoke alarms checked across all four floors.
        </p>
      </div>
    </div>
  );
}
