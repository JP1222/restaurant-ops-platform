"use client";

import type { AdminUser } from "@rop/contracts";
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
import { deleteGuardFor } from "@/lib/admin/delete-guard";
import { UserRowActions } from "./user-row-actions";

export function UsersTable({
  users,
  currentUserId
}: {
  users: AdminUser[];
  currentUserId?: string;
}) {
  if (users.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No admin users registered yet.</p>
    );
  }

  const ownerCount = users.filter((user) => user.role === "OWNER").length;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Username</TableHead>
          <TableHead>Display name</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Passkeys</TableHead>
          <TableHead>Created</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => (
          <TableRow key={user.id}>
            <TableCell className="font-mono text-sm">{user.username}</TableCell>
            <TableCell className="font-medium">{user.displayName}</TableCell>
            <TableCell>
              <Badge variant="outline">{user.role}</Badge>
            </TableCell>
            <TableCell className="tabular-nums">{user.passkeyCount}</TableCell>
            <TableCell className="text-muted-foreground">
              <RelativeTime iso={user.createdAt} />
            </TableCell>
            <TableCell className="text-right">
              <UserRowActions user={user} deleteGuard={deleteGuardFor(user, { currentUserId, ownerCount })} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
