import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LocationsTable } from "@/components/locations/locations-table";

export default function LocationsPage() {
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Stores</h1>
        <p className="text-muted-foreground text-sm">
          Your brand&apos;s locations. Add a store or rename one here; set per-store hours in
          Settings → Store Hours, and connect each store&apos;s POS to see its sales.
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Locations</CardTitle>
          <CardDescription>
            Every connected store appears here. The store switcher in the top bar appears once you
            have more than one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LocationsTable />
        </CardContent>
      </Card>
    </div>
  );
}
