export type SearchParamValue = string | string[] | undefined;
export type SearchParamsRecord = Record<string, SearchParamValue>;

export function pickSearchParam(value: SearchParamValue) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export function searchParamsToQueryString(
  params: SearchParamsRecord,
  { leadingQuestionMark = true }: { leadingQuestionMark?: boolean } = {}
) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item) {
          query.append(key, item);
        }
      }
      continue;
    }

    if (value) {
      query.set(key, value);
    }
  }

  const serialized = query.toString();
  if (!serialized) {
    return "";
  }

  return leadingQuestionMark ? `?${serialized}` : serialized;
}
