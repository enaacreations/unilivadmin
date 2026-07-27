import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@workspace/uniliv-admin';

export function SplitView() {
  return (
    <div className="h-48 max-w-lg">
      <ResizablePanelGroup
        direction="horizontal"
        className="rounded-lg border"
      >
      <ResizablePanel defaultSize={35}>
        <div className="flex h-full flex-col gap-1 p-4">
          <span className="text-xs font-medium uppercase text-muted-foreground">
            Properties
          </span>
          <span className="text-sm">Sunrise Residency</span>
          <span className="text-sm text-muted-foreground">Maple Court</span>
          <span className="text-sm text-muted-foreground">Harbour Heights</span>
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={65}>
        <div className="flex h-full flex-col gap-1 p-4">
          <span className="text-xs font-medium uppercase text-muted-foreground">
            Sunrise Residency · Details
          </span>
          <span className="text-sm">120 beds · 92.4% occupancy</span>
          <span className="text-sm text-muted-foreground">
            7 open complaints · last audit passed
          </span>
        </div>
      </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
