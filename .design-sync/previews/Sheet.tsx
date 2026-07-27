import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
  Input,
  Button,
} from '@workspace/uniliv-admin';

export function EditProperty() {
  return (
    <Sheet open>
      <SheetContent side="right" className="flex flex-col gap-6">
        <SheetHeader>
          <SheetTitle>Edit property</SheetTitle>
          <SheetDescription>
            Update the details for Sunrise Residency. Changes apply across
            occupancy, billing and audits.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Property name</label>
            <Input defaultValue="Sunrise Residency" />
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Address</label>
            <Input defaultValue="14 MG Road, Koramangala" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">City</label>
              <Input defaultValue="Bengaluru" />
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Total rooms</label>
              <Input defaultValue="86" />
            </div>
          </div>
        </div>
        <SheetFooter className="mt-auto">
          <Button variant="outline">Cancel</Button>
          <Button>Save changes</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
