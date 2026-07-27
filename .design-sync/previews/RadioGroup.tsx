import { RadioGroup, RadioGroupItem, Label } from '@workspace/uniliv-admin';

export function AuditFrequency() {
  return (
    <RadioGroup defaultValue="weekly" className="w-72">
      <div className="flex items-center gap-2">
        <RadioGroupItem value="daily" id="f-daily" />
        <Label htmlFor="f-daily">Daily walkthrough</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="weekly" id="f-weekly" />
        <Label htmlFor="f-weekly">Weekly inspection</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="monthly" id="f-monthly" />
        <Label htmlFor="f-monthly">Monthly deep audit</Label>
      </div>
    </RadioGroup>
  );
}

export function Horizontal() {
  return (
    <RadioGroup defaultValue="medium" className="flex flex-wrap gap-6">
      <div className="flex items-center gap-2">
        <RadioGroupItem value="low" id="sev-low" />
        <Label htmlFor="sev-low">Low</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="medium" id="sev-medium" />
        <Label htmlFor="sev-medium">Medium</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="high" id="sev-high" />
        <Label htmlFor="sev-high">High</Label>
      </div>
    </RadioGroup>
  );
}

export function WithDisabled() {
  return (
    <RadioGroup defaultValue="upi" className="w-72">
      <div className="flex items-center gap-2">
        <RadioGroupItem value="upi" id="p-upi" />
        <Label htmlFor="p-upi">UPI / Autopay</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="card" id="p-card" />
        <Label htmlFor="p-card">Debit / Credit card</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="cash" id="p-cash" disabled />
        <Label htmlFor="p-cash" className="opacity-70">
          Cash at desk (unavailable)
        </Label>
      </div>
    </RadioGroup>
  );
}
