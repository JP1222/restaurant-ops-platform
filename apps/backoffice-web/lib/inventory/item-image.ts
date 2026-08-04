// Same-origin URL for an item's photo. The browser can't reach inventory-api
// directly (Iron Law 4 / rule 11), so the bytes are proxied by the BFF route at
// /api/inventory/items/:id/image. The upstream sends `cache-control: no-cache`, so a
// re-upload shows immediately without a version query.
export function itemImageUrl(id: string): string {
  return `/api/inventory/items/${encodeURIComponent(id)}/image`;
}
