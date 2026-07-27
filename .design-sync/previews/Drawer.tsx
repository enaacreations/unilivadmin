import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerFooter,
  Button,
} from '@workspace/uniliv-admin';

export function AssignComplaint() {
  return (
    <Drawer open shouldScaleBackground={false}>
      <DrawerContent>
        <div className="mx-auto w-full max-w-md">
          <DrawerHeader>
            <DrawerTitle>Assign complaint #4821</DrawerTitle>
            <DrawerDescription>
              Route “Leaking tap · Room 214” to a facilities team member at
              Sunrise Residency.
            </DrawerDescription>
          </DrawerHeader>
          <div className="flex flex-col gap-2 px-4 pb-2">
            <button className="flex items-center justify-between rounded-md border bg-accent/10 px-3 py-2.5 text-left text-sm">
              <span className="font-medium">Ravi Kumar · Plumbing</span>
              <span className="text-xs text-accent-strong">2 open</span>
            </button>
            <button className="flex items-center justify-between rounded-md border px-3 py-2.5 text-left text-sm hover:bg-muted/40">
              <span className="font-medium">Meera Anand · Facilities</span>
              <span className="text-xs text-muted-foreground">5 open</span>
            </button>
            <button className="flex items-center justify-between rounded-md border px-3 py-2.5 text-left text-sm hover:bg-muted/40">
              <span className="font-medium">Deepak Warden · General</span>
              <span className="text-xs text-muted-foreground">1 open</span>
            </button>
          </div>
          <DrawerFooter>
            <Button>Assign ticket</Button>
            <Button variant="outline">Cancel</Button>
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
