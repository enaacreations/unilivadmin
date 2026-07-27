import { Textarea, Label } from '@workspace/uniliv-admin';

export function Basic() {
  return (
    <div className="grid gap-3 w-80">
      <Textarea placeholder="Describe the maintenance issue…" />
      <Textarea
        rows={4}
        defaultValue="Tap in the shared kitchen on Floor 3 has been leaking since Monday. Water is pooling near the electrical socket."
      />
    </div>
  );
}

export function WithLabel() {
  return (
    <div className="grid gap-1.5 w-80">
      <Label htmlFor="complaint">Complaint details</Label>
      <Textarea
        id="complaint"
        rows={4}
        placeholder="Add context for the facilities team…"
      />
    </div>
  );
}

export function Disabled() {
  return (
    <div className="grid gap-1.5 w-80">
      <Label htmlFor="notes">Internal notes</Label>
      <Textarea
        id="notes"
        disabled
        defaultValue="Read-only — resolved audits cannot be edited."
      />
    </div>
  );
}
