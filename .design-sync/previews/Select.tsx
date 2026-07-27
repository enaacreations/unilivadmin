import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectLabel,
  SelectGroup,
  SelectItem,
} from '@workspace/uniliv-admin';

export function PropertyPicker() {
  return (
    <Select open defaultValue="sunrise">
      <SelectTrigger className="w-56">
        <SelectValue placeholder="Select property" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Bengaluru</SelectLabel>
          <SelectItem value="sunrise">Sunrise Residency</SelectItem>
          <SelectItem value="urban-nest">Urban Nest Koramangala</SelectItem>
          <SelectItem value="green-meadows">Green Meadows</SelectItem>
        </SelectGroup>
        <SelectGroup>
          <SelectLabel>Pune</SelectLabel>
          <SelectItem value="lakeview">Lakeview Heights</SelectItem>
          <SelectItem value="maple-court">Maple Court</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
