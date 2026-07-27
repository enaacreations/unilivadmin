import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@workspace/uniliv-admin';

export function PropertyGallery() {
  const properties = [
    { name: 'Sunrise Residency', beds: 120, occ: '92%' },
    { name: 'Maple Court', beds: 84, occ: '88%' },
    { name: 'Harbour Heights', beds: 156, occ: '95%' },
  ];

  return (
    <Carousel className="w-64 mx-auto" opts={{ loop: true }}>
      <CarouselContent>
        {properties.map((p) => (
          <CarouselItem key={p.name} className="basis-full">
            <Card className="w-full">
              <CardHeader>
                <CardTitle className="text-base">{p.name}</CardTitle>
                <CardDescription>{p.beds} beds</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">{p.occ}</div>
                <p className="text-xs text-muted-foreground">Occupancy</p>
              </CardContent>
            </Card>
          </CarouselItem>
        ))}
      </CarouselContent>
      <div className="mt-3 flex items-center justify-center gap-2">
        <CarouselPrevious className="static translate-y-0" />
        <CarouselNext className="static translate-y-0" />
      </div>
    </Carousel>
  );
}
