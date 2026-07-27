import { Switch, Label } from '@workspace/uniliv-admin';

export function States() {
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="flex items-center gap-2">
        <Switch id="s-off" />
        <Label htmlFor="s-off">Off</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="s-on" defaultChecked />
        <Label htmlFor="s-on">On</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="s-dis" disabled />
        <Label htmlFor="s-dis">Disabled</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="s-dis-on" disabled defaultChecked />
        <Label htmlFor="s-dis-on">Disabled on</Label>
      </div>
    </div>
  );
}

export function NotificationSettings() {
  return (
    <div className="grid gap-4 w-80">
      <div className="flex items-center justify-between">
        <Label htmlFor="n-email">Email alerts</Label>
        <Switch id="n-email" defaultChecked />
      </div>
      <div className="flex items-center justify-between">
        <Label htmlFor="n-sms">SMS alerts</Label>
        <Switch id="n-sms" defaultChecked />
      </div>
      <div className="flex items-center justify-between">
        <Label htmlFor="n-push">Push notifications</Label>
        <Switch id="n-push" />
      </div>
      <div className="flex items-center justify-between">
        <Label htmlFor="n-wa">WhatsApp digest</Label>
        <Switch id="n-wa" />
      </div>
    </div>
  );
}
