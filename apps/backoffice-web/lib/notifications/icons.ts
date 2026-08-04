import {
  Bell,
  DollarSign,
  ExternalLink,
  EyeOff,
  FileText,
  GitCompare,
  type LucideIcon,
  Monitor,
  MonitorX,
  Package,
  PackagePlus,
  Plug,
  PlugZap,
  Scale,
  TrendingDown,
  TrendingUp,
  Truck,
  Users,
} from "lucide-react";

// Notifications carry icons as kebab-case lucide names (server-shaped data), so
// they resolve to components through this curated map rather than a dynamic
// import. Unknown names fall back to the bell.
const ICONS: Record<string, LucideIcon> = {
  "trending-down": TrendingDown,
  "trending-up": TrendingUp,
  package: Package,
  "package-plus": PackagePlus,
  "monitor-x": MonitorX,
  monitor: Monitor,
  users: Users,
  plug: Plug,
  "plug-zap": PlugZap,
  "file-text": FileText,
  truck: Truck,
  "external-link": ExternalLink,
  scale: Scale,
  "git-compare": GitCompare,
  "dollar-sign": DollarSign,
  "eye-off": EyeOff,
};

export function iconFor(name: string): LucideIcon {
  return ICONS[name] ?? Bell;
}
