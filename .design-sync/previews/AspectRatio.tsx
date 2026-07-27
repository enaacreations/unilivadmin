import { AspectRatio } from '@workspace/uniliv-admin';

export function Photo() {
  return (
    <div className="w-80">
      <AspectRatio
        ratio={16 / 9}
        className="overflow-hidden rounded-md bg-muted"
      >
        <img
          src="https://picsum.photos/id/1048/640/360"
          alt="Sunrise Residency lobby"
          className="h-full w-full object-cover"
        />
      </AspectRatio>
      <p className="mt-2 text-sm text-muted-foreground">
        Sunrise Residency · Lobby · 16:9
      </p>
    </div>
  );
}

export function Square() {
  return (
    <div className="w-40">
      <AspectRatio
        ratio={1}
        className="flex items-center justify-center rounded-md bg-primary/10 text-primary"
      >
        <span className="text-sm font-medium">Room 214</span>
      </AspectRatio>
      <p className="mt-2 text-center text-xs text-muted-foreground">
        Floor plan · 1:1
      </p>
    </div>
  );
}

export function Wide() {
  return (
    <div className="w-96">
      <AspectRatio
        ratio={21 / 9}
        className="flex items-center justify-center rounded-md bg-accent/12 text-accent-strong"
      >
        <span className="text-sm font-medium">Property banner · 21:9</span>
      </AspectRatio>
    </div>
  );
}
