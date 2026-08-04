declare module "next/headers" {
  export function headers(): Promise<{
    get(name: string): string | null;
  }>;

  export function cookies(): Promise<{
    get(name: string): { value: string } | undefined;
    toString(): string;
  }>;
}

declare module "next/navigation" {
  export function redirect(url: string): never;
}
