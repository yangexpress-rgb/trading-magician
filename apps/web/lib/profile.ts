import { z } from 'zod';

const TIMEZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

export const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'HKD', 'SGD'];
export const SUPPORTED_LOCALES = ['en-US', 'en-GB', 'en-CA', 'en-AU', 'de-DE', 'fr-FR', 'ja-JP'];

export const profileUpdateSchema = z.object({
  displayName: z.string().trim().min(1, 'Enter a display name').max(80),
  timezone: z.string().refine((tz) => TIMEZONES.has(tz), 'Choose a valid time zone'),
  baseCurrency: z
    .string()
    .toUpperCase()
    .refine((c) => CURRENCIES.has(c), 'Choose a valid currency'),
  locale: z.enum(SUPPORTED_LOCALES as [string, ...string[]], { message: 'Choose a locale' }),
});

export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;
