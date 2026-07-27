import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Badge,
} from '@workspace/uniliv-admin';

export function PropertyTabs() {
  return (
    <Tabs defaultValue="overview" className="w-full max-w-lg">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="rooms">Rooms</TabsTrigger>
        <TabsTrigger value="complaints">Complaints</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <div className="rounded-lg border p-4">
          <h4 className="text-sm font-semibold">Sunrise Residency</h4>
          <p className="mt-1 text-sm text-muted-foreground">
            120-bed co-living property in Koramangala. Occupancy sits at 92.4%
            with three rooms under notice period this month.
          </p>
          <div className="mt-3 flex gap-4 text-sm">
            <span className="text-muted-foreground">
              Occupancy <span className="font-medium text-foreground">92.4%</span>
            </span>
            <span className="text-muted-foreground">
              Open tickets <span className="font-medium text-foreground">7</span>
            </span>
          </div>
        </div>
      </TabsContent>
      <TabsContent value="rooms">
        <div className="rounded-lg border p-4 text-sm">
          <div className="flex items-center justify-between py-1">
            <span>Room 214 · Twin sharing</span>
            <Badge variant="success">Occupied</Badge>
          </div>
          <div className="flex items-center justify-between py-1">
            <span>Room 218 · Single</span>
            <Badge variant="secondary">Vacant</Badge>
          </div>
          <div className="flex items-center justify-between py-1">
            <span>Room 221 · Single</span>
            <Badge variant="warning">Notice period</Badge>
          </div>
        </div>
      </TabsContent>
      <TabsContent value="complaints">
        <div className="rounded-lg border p-4 text-sm text-muted-foreground">
          2 open complaints — a leaking tap in Room 214 and a Wi-Fi outage on the
          third floor. Average resolution time is 6 hours this week.
        </div>
      </TabsContent>
    </Tabs>
  );
}
