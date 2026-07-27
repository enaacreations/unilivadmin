import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
  Label,
} from '@workspace/uniliv-admin';
import { Search, IndianRupee, Send } from 'lucide-react';

export function SearchField() {
  return (
    <InputGroup className="w-80">
      <InputGroupAddon align="inline-start">
        <Search />
      </InputGroupAddon>
      <InputGroupInput placeholder="Search residents, rooms, audits…" />
    </InputGroup>
  );
}

export function WithButton() {
  return (
    <InputGroup className="w-80">
      <InputGroupInput placeholder="resident@uniliv.com" />
      <InputGroupAddon align="inline-end">
        <InputGroupButton variant="default" size="sm">
          Invite
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

export function PrefixSuffix() {
  return (
    <div className="grid gap-3 w-80">
      <InputGroup>
        <InputGroupAddon align="inline-start">
          <IndianRupee />
        </InputGroupAddon>
        <InputGroupInput defaultValue="18,500" />
        <InputGroupAddon align="inline-end">
          <InputGroupText>/ month</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      <InputGroup>
        <InputGroupInput defaultValue="sunrise-residency" />
        <InputGroupAddon align="inline-end">
          <InputGroupText>.uniliv.com</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

export function TextareaGroup() {
  return (
    <div className="grid gap-1.5 w-80">
      <Label>Reply to complaint</Label>
      <InputGroup>
        <InputGroupTextarea
          rows={3}
          placeholder="Type your response to the resident…"
        />
        <InputGroupAddon align="block-end">
          <InputGroupText>Room B-214</InputGroupText>
          <InputGroupButton
            variant="default"
            size="sm"
            className="ml-auto"
          >
            <Send /> Send
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
