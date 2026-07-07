import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";
import { useLocation } from "wouter";

export default function Forbidden() {
  const [, setLocation] = useLocation();
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-6">
      <ShieldAlert className="w-16 h-16 text-destructive mb-4" />
      <h1 className="font-display text-3xl font-bold mb-2">Access Denied</h1>
      <p className="text-muted-foreground max-w-md mb-6">
        You don't have permission to view this page. If you think this is a mistake, contact your administrator.
      </p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => window.history.back()}>Go Back</Button>
        <Button onClick={() => setLocation("/apps")}>Home</Button>
      </div>
    </div>
  );
}
