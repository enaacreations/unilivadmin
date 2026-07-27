import { ScrollArea, Badge } from '@workspace/uniliv-admin';

export function RoomList() {
  const rooms = [
    { no: '201', type: 'Single', status: 'Occupied', variant: 'success' as const },
    { no: '202', type: 'Twin', status: 'Occupied', variant: 'success' as const },
    { no: '203', type: 'Single', status: 'Vacant', variant: 'secondary' as const },
    { no: '204', type: 'Twin', status: 'Notice', variant: 'warning' as const },
    { no: '205', type: 'Single', status: 'Cleaning', variant: 'info' as const },
    { no: '206', type: 'Twin', status: 'Occupied', variant: 'success' as const },
    { no: '207', type: 'Single', status: 'Occupied', variant: 'success' as const },
    { no: '208', type: 'Deluxe', status: 'Maintenance', variant: 'destructive' as const },
    { no: '209', type: 'Single', status: 'Vacant', variant: 'secondary' as const },
    { no: '210', type: 'Twin', status: 'Occupied', variant: 'success' as const },
    { no: '211', type: 'Single', status: 'Occupied', variant: 'success' as const },
    { no: '212', type: 'Deluxe', status: 'Notice', variant: 'warning' as const },
  ];

  return (
    <ScrollArea className="h-48 w-72 rounded-md border p-4">
      <h4 className="mb-2 text-sm font-semibold leading-none">
        Sunrise Residency · Floor 2
      </h4>
      <div className="divide-y">
        {rooms.map((room) => (
          <div
            key={room.no}
            className="flex items-center justify-between py-2 text-sm"
          >
            <span>
              Room {room.no}
              <span className="text-muted-foreground"> · {room.type}</span>
            </span>
            <Badge variant={room.variant}>{room.status}</Badge>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
