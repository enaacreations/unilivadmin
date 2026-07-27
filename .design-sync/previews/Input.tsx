import { Input, Label } from '@workspace/uniliv-admin';

export function Basic() {
  return (
    <div className="grid gap-3 w-72">
      <Input placeholder="Search residents…" />
      <Input defaultValue="Aarav Sharma" />
      <Input disabled placeholder="Locked while syncing" />
    </div>
  );
}

export function WithLabels() {
  return (
    <div className="grid gap-4 w-72">
      <div className="grid gap-1.5">
        <Label htmlFor="email">Work email</Label>
        <Input id="email" type="email" placeholder="warden@uniliv.com" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="room">Room number</Label>
        <Input id="room" defaultValue="B-214" />
      </div>
    </div>
  );
}

export function Types() {
  return (
    <div className="grid gap-3 w-72">
      <Input type="text" defaultValue="Sunrise Residency" />
      <Input type="number" defaultValue={12} />
      <Input type="password" defaultValue="secret123" />
      <Input type="date" defaultValue="2026-07-25" />
      <Input type="file" />
    </div>
  );
}
