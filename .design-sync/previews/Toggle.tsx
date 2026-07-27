import { Toggle } from '@workspace/uniliv-admin';
import { Bold, Italic, Underline, Star } from 'lucide-react';

export function Variants() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Toggle aria-label="Default" defaultPressed>
        Available
      </Toggle>
      <Toggle variant="outline" aria-label="Outline">
        Occupied
      </Toggle>
    </div>
  );
}

export function Sizes() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Toggle size="sm" variant="outline" aria-label="Small">
        <Bold />
      </Toggle>
      <Toggle size="default" variant="outline" aria-label="Default">
        <Bold />
      </Toggle>
      <Toggle size="lg" variant="outline" aria-label="Large">
        <Bold />
      </Toggle>
    </div>
  );
}

export function WithIcons() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Toggle variant="outline" aria-label="Bold" defaultPressed>
        <Bold /> Bold
      </Toggle>
      <Toggle variant="outline" aria-label="Italic">
        <Italic /> Italic
      </Toggle>
      <Toggle variant="outline" aria-label="Underline">
        <Underline /> Underline
      </Toggle>
    </div>
  );
}

export function States() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Toggle aria-label="Pressed" defaultPressed>
        <Star /> Starred
      </Toggle>
      <Toggle aria-label="Off">
        <Star /> Star
      </Toggle>
      <Toggle aria-label="Disabled" disabled>
        <Star /> Disabled
      </Toggle>
    </div>
  );
}
