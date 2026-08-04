const DEFAULT_DAYS = 30;
const MIN_DAYS = 7;
const MAX_DAYS = 90;
const MAX_ITEM_LENGTH = 128;

export interface MenuFilters {
  days: number;
  item: string | null;
}

function defaultFilters(): MenuFilters {
  return {
    days: DEFAULT_DAYS,
    item: null
  };
}

export function parseMenuFilters(searchParams: URLSearchParams): MenuFilters {
  const defaults = defaultFilters();
  const rawDays = searchParams.get("days");
  let days = defaults.days;
  if (rawDays != null) {
    const parsed = Number(rawDays);
    if (Number.isInteger(parsed) && parsed >= MIN_DAYS && parsed <= MAX_DAYS) {
      days = parsed;
    }
  }

  const rawItem = searchParams.get("item");
  let item: string | null = defaults.item;
  if (rawItem != null && rawItem.length > 0 && rawItem.length <= MAX_ITEM_LENGTH) {
    item = rawItem;
  }

  return { days, item };
}

export function serializeMenuFilters(filters: MenuFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.days !== DEFAULT_DAYS) {
    params.set("days", String(filters.days));
  }
  if (filters.item) {
    params.set("item", filters.item);
  }
  return params;
}
