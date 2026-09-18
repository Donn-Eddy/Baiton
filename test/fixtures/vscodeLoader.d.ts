export function resolve(
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context?: unknown) => Promise<unknown>,
): Promise<unknown>;
