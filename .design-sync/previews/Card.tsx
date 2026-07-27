import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Button,
  Badge,
} from '@workspace/uniliv-admin';

export function Metric() {
  return (
    <Card className="w-80">
      <CardHeader>
        <CardDescription>Occupancy this month</CardDescription>
        <CardTitle className="text-3xl">92.4%</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-success">+3.1% vs last month</p>
      </CardContent>
    </Card>
  );
}

export function WithFooter() {
  return (
    <Card className="w-80">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Maintenance request</CardTitle>
          <Badge variant="secondary">Open</Badge>
        </div>
        <CardDescription>Room 214 · Leaking tap</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Reported 2 hours ago by the resident. Assigned to the facilities team for
        same-day resolution.
      </CardContent>
      <CardFooter className="gap-2">
        <Button size="sm">Resolve</Button>
        <Button size="sm" variant="outline">
          Reassign
        </Button>
      </CardFooter>
    </Card>
  );
}
