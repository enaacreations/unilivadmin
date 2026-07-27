import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
  TableCaption,
  Badge,
} from '@workspace/uniliv-admin';

export function AuditRegister() {
  const rows = [
    {
      id: 'AUD-2041',
      property: 'Sunrise Residency',
      template: 'Fire & Safety',
      auditor: 'Priya Nair',
      score: '94%',
      status: 'Passed',
      variant: 'success' as const,
    },
    {
      id: 'AUD-2039',
      property: 'Maple Court',
      template: 'Kitchen Hygiene',
      auditor: 'Rahul Mehta',
      score: '71%',
      status: 'Needs review',
      variant: 'warning' as const,
    },
    {
      id: 'AUD-2036',
      property: 'Harbour Heights',
      template: 'Housekeeping',
      auditor: 'Aisha Khan',
      score: '58%',
      status: 'Failed',
      variant: 'destructive' as const,
    },
    {
      id: 'AUD-2033',
      property: 'Cedar Lodge',
      template: 'Fire & Safety',
      auditor: 'Vikram Rao',
      score: '—',
      status: 'In progress',
      variant: 'info' as const,
    },
    {
      id: 'AUD-2030',
      property: 'Willow Park',
      template: 'Maintenance',
      auditor: 'Neha Gupta',
      score: '88%',
      status: 'Passed',
      variant: 'success' as const,
    },
  ];

  return (
    <Table>
      <TableCaption>Recent inspections across the portfolio</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Audit</TableHead>
          <TableHead>Property</TableHead>
          <TableHead>Template</TableHead>
          <TableHead>Auditor</TableHead>
          <TableHead className="text-right">Score</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium">{row.id}</TableCell>
            <TableCell>{row.property}</TableCell>
            <TableCell className="text-muted-foreground">{row.template}</TableCell>
            <TableCell>{row.auditor}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {row.score}
            </TableCell>
            <TableCell>
              <Badge variant={row.variant}>{row.status}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
