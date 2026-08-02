import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const [dark, setDark] = React.useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("uniliv_theme") === "dark";
  });
  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("uniliv_theme", dark ? "dark" : "light");
  }, [dark]);
  return (
    <Button
      variant="outline"
      size="icon"
      onClick={() => setDark((d) => !d)}
      aria-label="Toggle theme"
      className="h-[38px] w-[38px] rounded-[10px] border-border bg-card text-foreground"
    >
      {dark ? <Sun className="h-[17px] w-[17px]" /> : <Moon className="h-[17px] w-[17px]" />}
    </Button>
  );
}
