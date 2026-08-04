"use client";

import type { InventoryEmployee } from "@rop/contracts";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { RelativeTime } from "@/components/ops/relative-time";
import { CrewRowActions } from "./crew-row-actions";

export function CrewTable({ employees }: { employees: InventoryEmployee[] }) {
  if (employees.length === 0) {
    return <p className="text-sm text-muted-foreground">No crew members yet.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Shift</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {employees.map((employee) => (
          <TableRow key={employee.id} className={employee.active ? undefined : "opacity-60"}>
            <TableCell className="font-medium">
              <span className="inline-flex items-center gap-2">
                <span
                  className="inline-flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground"
                  aria-hidden
                >
                  {employee.initials}
                </span>
                {employee.name}
              </span>
            </TableCell>
            <TableCell>
              <Badge variant="outline">{employee.role}</Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">{employee.shift}</TableCell>
            <TableCell>
              <Badge variant={employee.active ? "default" : "secondary"}>
                {employee.active ? "Active" : "Disabled"}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">
              <RelativeTime iso={employee.updated_at} />
            </TableCell>
            <TableCell className="text-right">
              <CrewRowActions employee={employee} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
