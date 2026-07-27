import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from '@workspace/uniliv-admin';
import { Bar, BarChart, XAxis, CartesianGrid } from 'recharts';

const data = [
  { property: 'Sunrise', completed: 18, pending: 3 },
  { property: 'Maple', completed: 12, pending: 5 },
  { property: 'Harbour', completed: 21, pending: 2 },
  { property: 'Cedar', completed: 9, pending: 6 },
  { property: 'Willow', completed: 15, pending: 4 },
];

const config = {
  completed: { label: 'Completed', color: '#E8602C' },
  pending: { label: 'Pending', color: '#F6C6AC' },
};

export function AuditsByProperty() {
  return (
    <ChartContainer config={config} className="h-48 w-full max-w-md">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="property"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="completed" fill="var(--color-completed)" radius={4} />
        <Bar dataKey="pending" fill="var(--color-pending)" radius={4} />
      </BarChart>
    </ChartContainer>
  );
}
