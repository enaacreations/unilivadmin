import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
} from '@workspace/uniliv-admin';

export function Confirmation() {
  return (
    <Dialog open>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this audit?</DialogTitle>
          <DialogDescription>
            This permanently removes the audit and all of its responses. This action
            cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline">Cancel</Button>
          <Button variant="destructive">Delete audit</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
