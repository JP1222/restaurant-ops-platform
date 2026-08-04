import { RecipeEditor } from "@/components/inventory/recipe-editor";

export default async function RecipeEditorPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <RecipeEditor recipeId={id} />;
}
