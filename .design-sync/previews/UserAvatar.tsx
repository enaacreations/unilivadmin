import { UserAvatar } from '@workspace/uniliv-admin';

export function Initials() {
  return (
    <div className="flex items-center gap-3">
      <UserAvatar name="Sumit Chauhan" />
      <UserAvatar name="Priya Nair" />
      <UserAvatar name="Arjun Mehta" />
      <UserAvatar name="Fatima Sheikh" />
    </div>
  );
}

export function WithPhoto() {
  return (
    <div className="flex items-center gap-3">
      <UserAvatar name="Deepa Warden" src="https://i.pravatar.cc/80?img=47" />
      <UserAvatar name="Ravi Kumar" src="https://i.pravatar.cc/80?img=15" />
      <UserAvatar name="Meera Auditor" src="https://i.pravatar.cc/80?img=25" />
    </div>
  );
}

export function Sizes() {
  return (
    <div className="flex items-center gap-3">
      <UserAvatar name="Sumit Chauhan" className="h-6 w-6 text-xs" />
      <UserAvatar name="Sumit Chauhan" />
      <UserAvatar name="Sumit Chauhan" className="h-12 w-12 text-base" />
      <UserAvatar name="Sumit Chauhan" className="h-16 w-16 text-lg" />
    </div>
  );
}
