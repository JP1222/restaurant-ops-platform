// Shared field constants for the floor item forms (add + edit). Kept here so the
// quick-add and the edit flow can't drift on the unit list. Categories come from
// the live dataset (useCrewData), not a constant.

// Sentinel for the "Other…" unit chip — when picked, a free-text input supplies
// the real unit string.
export const OTHER_UNIT = "__other__";

export const UNIT_OPTIONS = ["each", "case", "bag", "box", "btl", "jar", "kg", "g", "L", "ml"];
