import { Avatar, AvatarImage, AvatarFallback } from '@workspace/uniliv-admin';

export function WithImage() {
  return (
    <Avatar>
      <AvatarImage src="https://i.pravatar.cc/80?img=5" alt="Priya Nair" />
      <AvatarFallback>PN</AvatarFallback>
    </Avatar>
  );
}

export function FallbackOnly() {
  return (
    <div className="flex items-center gap-3">
      <Avatar>
        <AvatarFallback>SC</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback className="bg-primary/10 text-primary font-medium">
          RK
        </AvatarFallback>
      </Avatar>
      <Avatar className="h-12 w-12">
        <AvatarFallback className="bg-accent/12 text-accent-strong font-medium">
          AM
        </AvatarFallback>
      </Avatar>
    </div>
  );
}

export function Stack() {
  return (
    <div className="flex -space-x-3">
      <Avatar className="ring-2 ring-background">
        <AvatarImage src="https://i.pravatar.cc/80?img=12" alt="Warden" />
        <AvatarFallback>DW</AvatarFallback>
      </Avatar>
      <Avatar className="ring-2 ring-background">
        <AvatarImage src="https://i.pravatar.cc/80?img=32" alt="Auditor" />
        <AvatarFallback>MA</AvatarFallback>
      </Avatar>
      <Avatar className="ring-2 ring-background">
        <AvatarFallback className="bg-primary/10 text-primary font-medium">
          SC
        </AvatarFallback>
      </Avatar>
      <Avatar className="ring-2 ring-background">
        <AvatarFallback className="bg-muted text-muted-foreground text-xs font-medium">
          +6
        </AvatarFallback>
      </Avatar>
    </div>
  );
}
