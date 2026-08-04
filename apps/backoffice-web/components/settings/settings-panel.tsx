import type { ReactNode } from "react";
import { HelpRail } from "./help-rail";
import { SectionHeader } from "./section-header";
import { SECTION_HELP, SECTION_SUBTITLE, WIDE_SECTIONS, getSettingsSection } from "./settings-nav-data";

interface SettingsPanelProps {
  id: string;
  children: ReactNode;
  /** Optional right-aligned action in the section header. */
  action?: ReactNode;
}

/**
 * Content-area wrapper for every Settings section: applies the scroll padding,
 * renders the section header, and chooses the layout — a two-column form + help
 * rail (which wraps to one column under ~1100px) for form sections, or a wider
 * full-bleed container for list/grid sections (see WIDE_SECTIONS).
 */
export function SettingsPanel({ id, children, action }: SettingsPanelProps) {
  const section = getSettingsSection(id);
  if (!section) return null;

  const help = SECTION_HELP[id];
  const wide = WIDE_SECTIONS.has(id);
  const useHelp = Boolean(help) && !wide;

  return (
    <div className="mx-auto w-full px-6 py-7 pb-16 sm:px-10" style={{ maxWidth: wide ? 1240 : 1180 }}>
      <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300">
        <div className="mb-6" style={{ maxWidth: wide ? undefined : 760 }}>
          <SectionHeader
            icon={section.icon}
            title={section.label}
            subtitle={SECTION_SUBTITLE[id]}
            tone={section.tone}
            action={action}
          />
        </div>

        {useHelp && help ? (
          <div className="flex flex-wrap items-start gap-7">
            <div className="min-w-0" style={{ flex: "5 1 480px", maxWidth: 760 }}>
              {children}
            </div>
            <HelpRail help={help} />
          </div>
        ) : (
          <div style={{ maxWidth: wide ? undefined : 760 }}>{children}</div>
        )}
      </div>
    </div>
  );
}
