import { Label, Input, Checkbox, Switch } from '@workspace/uniliv-admin';

export function WithInput() {
  return (
    <div className="grid gap-4 w-72">
      <div className="grid gap-1.5">
        <Label htmlFor="property">Property name</Label>
        <Input id="property" defaultValue="Sunrise Residency" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="unit">Unit / bed</Label>
        <Input id="unit" placeholder="e.g. B-214" />
      </div>
    </div>
  );
}

export function WithControls() {
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Checkbox id="terms" defaultChecked />
        <Label htmlFor="terms">Resident has signed the tenancy agreement</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="alerts" defaultChecked />
        <Label htmlFor="alerts">Send occupancy alerts</Label>
      </div>
    </div>
  );
}

export function Required() {
  return (
    <div className="grid gap-1.5 w-72">
      <Label htmlFor="checkin" className="flex items-center gap-1">
        Check-in date <span className="text-destructive">*</span>
      </Label>
      <Input id="checkin" type="date" defaultValue="2026-07-25" />
    </div>
  );
}
