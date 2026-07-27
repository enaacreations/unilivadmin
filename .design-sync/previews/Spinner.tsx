import { Spinner, Button } from '@workspace/uniliv-admin';

export function Sizes() {
  return (
    <div className="flex items-center gap-6">
      <Spinner className="size-4" />
      <Spinner className="size-6 text-primary" />
      <Spinner className="size-8 text-accent-strong" />
    </div>
  );
}

export function Centered() {
  return (
    <div className="flex h-32 w-64 flex-col items-center justify-center gap-3 rounded-lg border">
      <Spinner className="size-6 text-primary" />
      <p className="text-sm text-muted-foreground">Loading audit responses…</p>
    </div>
  );
}

export function InButton() {
  return (
    <div className="flex items-center gap-3">
      <Button disabled>
        <Spinner /> Saving
      </Button>
      <Button variant="outline" disabled>
        <Spinner /> Syncing rooms
      </Button>
    </div>
  );
}
