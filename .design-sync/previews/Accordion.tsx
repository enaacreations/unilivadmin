import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@workspace/uniliv-admin';

export function AuditFAQ() {
  return (
    <Accordion
      type="single"
      collapsible
      defaultValue="item-1"
      className="w-full max-w-lg"
    >
      <AccordionItem value="item-1">
        <AccordionTrigger>How is an audit score calculated?</AccordionTrigger>
        <AccordionContent className="text-muted-foreground">
          Each answered question contributes a weighted score based on its
          template. Ratings apply a multiplier, and any failed critical item caps
          the overall result until it is remediated.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-2">
        <AccordionTrigger>
          Who can reopen a completed inspection?
        </AccordionTrigger>
        <AccordionContent className="text-muted-foreground">
          Property wardens and org-wide auditors can reopen an inspection within
          72 hours. After that, a compliance manager must approve the reopening
          to preserve the audit trail.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-3">
        <AccordionTrigger>
          What happens when a property fails?
        </AccordionTrigger>
        <AccordionContent className="text-muted-foreground">
          A corrective-action plan is created automatically and assigned to the
          on-site team. The property is flagged on the dashboard until every
          critical finding is closed and re-verified.
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
