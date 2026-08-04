import {
  Bell,
  Bot,
  Clock,
  type LucideIcon,
  Monitor,
  Palette,
  Plug,
  RotateCcw,
  Settings,
  SlidersHorizontal,
  Store,
  TrendingUp,
  TriangleAlert,
  User,
  Users,
  MapPin,
} from "lucide-react";

// Single source of truth for the Settings center IA. The left rail, the section
// header, the breadcrumb, and the contextual help rail all read from here so a
// new section is added in exactly one place.
export type SettingsNavItem = {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  desc: string;
  badge?: string;
  tone?: "danger";
};

export type SettingsNavGroup = {
  group: string;
  items: SettingsNavItem[];
};

export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    group: "Account",
    items: [
      { id: "general", label: "General", href: "/settings/general", icon: Settings, desc: "Workspace name, locale, defaults" },
      { id: "stores", label: "Stores", href: "/settings/stores", icon: MapPin, desc: "Locations and POS connections" },
      { id: "hours", label: "Store Hours", href: "/settings/hours", icon: Clock, desc: "Opening hours per day, per store" },
      { id: "profile", label: "Profile", href: "/settings/profile", icon: User, desc: "Your operator account" },
      { id: "notifications", label: "Notifications", href: "/settings/notifications", icon: Bell, desc: "Alerts & digests" },
      { id: "appearance", label: "Appearance", href: "/settings/appearance", icon: Palette, desc: "Theme & density" },
    ],
  },
  {
    group: "KDS",
    items: [
      { id: "board", label: "Board Settings", href: "/settings/board", icon: SlidersHorizontal, desc: "Urgency, weather, board behavior" },
      { id: "devices", label: "Devices", href: "/settings/devices", icon: Monitor, desc: "KDS & guest display screens" },
      { id: "reset", label: "Daily Reset", href: "/settings/reset", icon: RotateCcw, desc: "Schedule & manual run" },
    ],
  },
  {
    group: "System",
    items: [
      { id: "ai", label: "AI Assistant", href: "/settings/ai", icon: Bot, desc: "Providers, models & limits", badge: "Live" },
      { id: "integrations", label: "Integrations", href: "/settings/integrations", icon: Plug, desc: "Clover, Deliverect" },
      { id: "team", label: "Team & Access", href: "/settings/team", icon: Users, desc: "Users & passkeys" },
    ],
  },
  {
    group: "Advanced",
    items: [
      { id: "danger", label: "Danger Zone", href: "/settings/danger", icon: TriangleAlert, desc: "Destructive operations", tone: "danger" },
    ],
  },
];

export const SETTINGS_NAV_FLAT: SettingsNavItem[] = SETTINGS_NAV.flatMap((g) => g.items);

export function getSettingsSection(id: string): SettingsNavItem | undefined {
  return SETTINGS_NAV_FLAT.find((item) => item.id === id);
}

// Per-section subtitle rendered under the section header.
export const SECTION_SUBTITLE: Record<string, string> = {
  stores: "Your store locations and their POS connections. Add a store to expand to a new location.",
  general: "Workspace identity and locale. Changes save immediately and apply to the next request.",
  hours: "Opening hours per weekday, in the store's local time. Drives the dashboard's pre-open vs. open framing. Per store (ADR-0018).",
  profile: "Your operator account — sign-in, identity, and passkeys.",
  notifications: "Choose how the backoffice reaches you when something needs attention.",
  appearance: "Make the backoffice comfortable for your room and your eyes.",
  ai: "Providers, models, fallbacks, and limits. Saves immediately and applies to the next request — no redeploy.",
  integrations: "Connected point-of-sale, delivery, and messaging services.",
  devices: "Kitchen displays and guest screens paired to this store.",
  board: "How the KDS board groups, sorts, and ages tickets.",
  team: "People with access to the backoffice, their roles, and passkeys.",
  reset: "Close the current business day and roll reporting forward.",
  danger: "Irreversible and high-impact operations. Proceed with care.",
};

// Contextual help shown in the right rail for form-style sections. List/grid
// sections (Integrations, Devices, Team, Notifications, Board, Reset) render
// full-width with no help rail — see WIDE_SECTIONS below.
export type HelpLink = { label: string; icon: LucideIcon; href?: string };
export type SectionHelp = { tone?: "danger"; tip: string; links?: HelpLink[] };

export const SECTION_HELP: Record<string, SectionHelp> = {
  general: {
    tip: "Workspace identity is shared by everyone on this store. Locale and reset timing drive how analytics days are bucketed.",
    links: [
      { label: "Reporting & day boundaries", icon: TrendingUp, href: "/trends" },
      { label: "Manage stores", icon: Store, href: "/locations" },
    ],
  },
  profile: {
    tip: "This is your personal operator account. Changes here only affect you, not the rest of the team. Add passkeys directly on the Passkeys row for passwordless sign-in.",
  },
  appearance: {
    tip: "Light mode is recommended on glare-prone kitchen screens. Preferences are stored per operator on this device.",
    links: [{ label: "Display & KDS settings", icon: Monitor, href: "/settings/devices" }],
  },
  danger: {
    tone: "danger",
    tip: "Everything here is high-impact or irreversible. The daily reset runs automatically at close — only act manually if you're certain.",
    links: [{ label: "Daily reset schedule", icon: RotateCcw, href: "/settings/reset" }],
  },
};

// Sections that render full-width with no help rail (cards/tables that need
// room). Board + Reset are card-forms now, so they stay at the capped form
// width like the other Account/System form panels.
export const WIDE_SECTIONS = new Set([
  "stores",
  "integrations",
  "devices",
  "team",
  "notifications",
]);
