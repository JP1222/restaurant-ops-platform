"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreateRecipe } from "@/hooks/use-inventory";
import type { InventoryDataset } from "@rop/contracts";

// New recipe (menu item) — header only: name, menu category, sell price. Creates the
// recipe with an empty BOM, then jumps to the editor to add ingredients. The menu
// `category` is a free label (e.g. "Milk Tea"), distinct from the item categories;
// a datalist offers the ones already in use.
export function NewRecipeDialog({
  open,
  onOpenChange,
  data
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: InventoryDataset;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [sell, setSell] = useState("");
  const create = useCreateRecipe();

  const existingCategories = Array.from(
    new Set(data.recipes.map((r) => r.category).filter((c) => c.trim() !== ""))
  ).sort();

  const sellCents = Math.round((parseFloat(sell) || 0) * 100);
  const valid = name.trim() !== "" && category.trim() !== "" && sellCents > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!valid) return;
            const created = await create.mutateAsync({
              name: name.trim(),
              category: category.trim(),
              sell_cents: sellCents
            });
            onOpenChange(false);
            router.push(`/inventory/recipes/${created.id}`);
          }}
        >
          <DialogHeader>
            <DialogTitle>New recipe</DialogTitle>
            <DialogDescription>
              Name it, set the menu category + sell price. You add the ingredients (the
              recipe&rsquo;s bill of materials) on the next screen.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1">
            <Label htmlFor="new-recipe-name">Name</Label>
            <Input
              id="new-recipe-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Taro Milk Tea"
              maxLength={120}
              required
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="new-recipe-category">Category</Label>
              <Input
                id="new-recipe-category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                placeholder="Milk Tea"
                list="new-recipe-categories"
                maxLength={80}
                required
              />
              <datalist id="new-recipe-categories">
                {existingCategories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-recipe-sell">Sell price $</Label>
              <Input
                id="new-recipe-sell"
                value={sell}
                inputMode="decimal"
                onChange={(event) => setSell(event.target.value)}
                placeholder="6.50"
                required
              />
            </div>
          </div>

          {create.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not create the recipe</AlertTitle>
              <AlertDescription>
                {create.error instanceof Error ? create.error.message : "Unknown error"}
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !valid}>
              {create.isPending ? "Creating…" : "Create + add ingredients"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
