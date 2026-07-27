import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldContent,
  FieldSet,
  FieldLegend,
  FieldSeparator,
  Input,
  Textarea,
  Switch,
} from '@workspace/uniliv-admin';

export function Vertical() {
  return (
    <FieldGroup className="w-80">
      <Field>
        <FieldLabel htmlFor="prop-name">Property name</FieldLabel>
        <Input id="prop-name" defaultValue="Sunrise Residency" />
        <FieldDescription>Shown to residents on their invoices.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="prop-notes">Onboarding notes</FieldLabel>
        <Textarea id="prop-notes" rows={3} placeholder="Anything the warden should know…" />
      </Field>
    </FieldGroup>
  );
}

export function Horizontal() {
  return (
    <FieldGroup className="w-96">
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="auto-renew">Auto-renew tenancy</FieldLabel>
          <FieldDescription>
            Extend agreements 30 days before they expire.
          </FieldDescription>
        </FieldContent>
        <Switch id="auto-renew" defaultChecked />
      </Field>
      <FieldSeparator />
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="late-fee">Charge late fees</FieldLabel>
          <FieldDescription>Apply after a 5-day grace period.</FieldDescription>
        </FieldContent>
        <Switch id="late-fee" />
      </Field>
    </FieldGroup>
  );
}

export function WithError() {
  return (
    <FieldGroup className="w-80">
      <Field data-invalid="true">
        <FieldLabel htmlFor="room-no">Room number</FieldLabel>
        <Input id="room-no" aria-invalid defaultValue="" placeholder="e.g. B-214" />
        <FieldError>Room number is required.</FieldError>
      </Field>
    </FieldGroup>
  );
}

export function Fieldset() {
  return (
    <FieldSet className="w-80">
      <FieldLegend>Audit scope</FieldLegend>
      <FieldDescription>Choose which areas this walkthrough covers.</FieldDescription>
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="scope-common">Common areas</FieldLabel>
          </FieldContent>
          <Switch id="scope-common" defaultChecked />
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="scope-kitchen">Kitchen &amp; F&amp;B</FieldLabel>
          </FieldContent>
          <Switch id="scope-kitchen" defaultChecked />
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="scope-rooms">Resident rooms</FieldLabel>
          </FieldContent>
          <Switch id="scope-rooms" />
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}
