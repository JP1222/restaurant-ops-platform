"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useOpsDatabase } from "@/hooks/use-ops";
import { RelativeTime } from "./relative-time";

const numberFormatter = new Intl.NumberFormat("en-US");

function count(value: number | string) {
  return numberFormatter.format(Number(value ?? 0));
}

export function DatabaseTab() {
  const query = useOpsDatabase();

  if (query.isLoading) {
    return <Skeleton className="h-[400px] w-full" />;
  }

  if (query.isError || !query.data) {
    return <p className="text-sm text-muted-foreground">Could not load database stats.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Storage summary</CardTitle>
          <CardDescription>
            {count(query.data.totals.table_count)} tracked tables - {query.data.totals.size_pretty} total
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Tables</CardTitle>
          <CardDescription>
            Mart, audit, meta, and raw schemas. Largest relations first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Schema / Table</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Last refresh</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.tables.map((table) => (
                <TableRow key={`${table.schema}.${table.table_name}`}>
                  <TableCell className="font-mono text-xs">
                    <span className="text-muted-foreground">{table.schema}.</span>
                    <span>{table.table_name}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{count(table.row_count)}</TableCell>
                  <TableCell className="text-right tabular-nums">{table.size_pretty}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    <RelativeTime iso={table.last_refreshed_at} />
                  </TableCell>
                </TableRow>
              ))}
              {query.data.tables.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    No tracked tables found.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
