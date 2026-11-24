// Lets inline styles set CSS custom properties, e.g. style={{ "--gap": "8px" }}.
import "react";

declare module "react" {
  interface CSSProperties {
    [customProperty: `--${string}`]: string | number | undefined;
  }
}
