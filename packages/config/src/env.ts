import { z } from 'zod';

export class EnvValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Parses environment variables against a schema. Error messages name the
 * offending variables but never echo their values, so secrets cannot leak
 * into logs through a failed boot (Design v1.0 §16.1).
 */
export function parseEnv<T extends z.ZodRawShape>(
  shape: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<z.ZodObject<T>> {
  const result = z.object(shape).safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return `${name}: ${issue.code === 'invalid_type' && source[name] === undefined ? 'is required' : 'is invalid'}`;
    });
    throw new EnvValidationError(issues);
  }
  return result.data;
}

export const nodeEnv = z.enum(['development', 'test', 'production']).default('development');
export const logLevel = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  .default('info');
