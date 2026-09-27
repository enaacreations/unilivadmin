import * as React from "react";
import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * Follow the app's OWN theme.
 *
 * The shadcn original reads `next-themes`, which this app does not use — dark
 * mode here is `theme-toggle.tsx` putting a `dark` class on <html> and writing
 * `uniliv_theme`. Reading next-themes would have left every toast light while
 * the rest of the page went dark, so the class is observed directly.
 */
function useAppTheme(): "light" | "dark" {
  const read = () =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? "dark"
      : "light";
  const [theme, setTheme] = React.useState<"light" | "dark">(read);

  React.useEffect(() => {
    // The toggle mutates the class rather than raising an event, so watch the
    // attribute — a state subscription would need the toggle to know about us.
    const el = document.documentElement;
    const ob = new MutationObserver(() => setTheme(read()));
    ob.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => ob.disconnect();
  }, []);

  return theme;
}

/**
 * `richColors` is the point of this change: sonner's plain toast is the same
 * neutral card for "Saved" and "Refused", so the only thing carrying the
 * outcome was the words. With rich colours the variant chosen in use-toast.ts
 * reads as green / red / amber / blue before anything is read at all.
 */
export function Toaster(props: ToasterProps) {
  const theme = useAppTheme();

  return (
    <Sonner
      theme={theme}
      richColors
      closeButton
      position="bottom-right"
      // The app's own radius and font, so a toast does not look like it came
      // from a different product.
      toastOptions={{
        classNames: {
          toast: "rounded-[var(--radius,10px)] text-[13.5px]",
          title: "font-semibold",
          description: "text-[12.5px] opacity-90",
        },
      }}
      {...props}
    />
  );
}
