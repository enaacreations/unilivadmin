import { Kbd, KbdGroup } from '@workspace/uniliv-admin';

export function SingleKeys() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Kbd>⌘</Kbd>
      <Kbd>K</Kbd>
      <Kbd>⇧</Kbd>
      <Kbd>Esc</Kbd>
      <Kbd>Enter</Kbd>
    </div>
  );
}

export function Shortcuts() {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-center gap-3">
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
        <span className="text-muted-foreground">Open command palette</span>
      </div>
      <div className="flex items-center gap-3">
        <KbdGroup>
          <Kbd>Ctrl</Kbd>
          <Kbd>S</Kbd>
        </KbdGroup>
        <span className="text-muted-foreground">Save audit draft</span>
      </div>
      <div className="flex items-center gap-3">
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>⇧</Kbd>
          <Kbd>N</Kbd>
        </KbdGroup>
        <span className="text-muted-foreground">New complaint ticket</span>
      </div>
    </div>
  );
}

export function InlineHint() {
  return (
    <p className="max-w-sm text-sm text-muted-foreground">
      Press{' '}
      <KbdGroup>
        <Kbd>⌘</Kbd>
        <Kbd>F</Kbd>
      </KbdGroup>{' '}
      to filter rooms, or <Kbd>/</Kbd> to jump to search.
    </p>
  );
}
