'use client';

import { Alert, Button, SelectField, TextField } from '@tm/ui';
import Link from 'next/link';
import { useActionState, useState } from 'react';
import { COMMON_CURRENCIES, SUPPORTED_LOCALES } from '@/lib/profile';
import { updateProfile, type ProfileFormState } from './actions';

const LOCALE_NAMES: Record<string, string> = {
  'en-US': 'English (United States)',
  'en-GB': 'English (United Kingdom)',
  'en-CA': 'English (Canada)',
  'en-AU': 'English (Australia)',
  'de-DE': 'Deutsch (Deutschland)',
  'fr-FR': 'Français (France)',
  'ja-JP': '日本語 (日本)',
};

/** A sample date and amount in the chosen format, so the choice is visible before saving. */
function formatExample(locale: string, timeZone: string, currency: string): string {
  const sample = new Date('2026-10-06T14:30:00Z');
  try {
    const when = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(sample);
    const amount = new Intl.NumberFormat(locale, { style: 'currency', currency }).format(12345.67);
    return `${when} · ${amount}`;
  } catch {
    return '';
  }
}

interface Props {
  profile: { displayName: string; timezone: string; baseCurrency: string; locale: string };
  timezones: string[];
}

export function ProfileForm({ profile, timezones }: Props) {
  const [state, action, pending] = useActionState<ProfileFormState, FormData>(updateProfile, {
    status: 'idle',
  });
  const [locale, setLocale] = useState(profile.locale);
  const [timezone, setTimezone] = useState(profile.timezone);
  const [currency, setCurrency] = useState(profile.baseCurrency);
  const currencies = COMMON_CURRENCIES.includes(profile.baseCurrency)
    ? COMMON_CURRENCIES
    : [profile.baseCurrency, ...COMMON_CURRENCIES];

  return (
    <form action={action} className="space-y-4" aria-label="Profile">
      <TextField
        label="Display name"
        name="displayName"
        defaultValue={profile.displayName}
        error={state.errors?.displayName}
        required
      />
      <SelectField
        label="Time zone"
        name="timezone"
        value={timezone}
        onChange={(e) => setTimezone(e.target.value)}
        error={state.errors?.timezone}
        hint="Times across the app are shown in this zone."
      >
        {timezones.map((tz) => (
          <option key={tz}>{tz}</option>
        ))}
      </SelectField>
      <SelectField
        label="Base currency"
        name="baseCurrency"
        value={currency}
        onChange={(e) => setCurrency(e.target.value)}
        error={state.errors?.baseCurrency}
      >
        {currencies.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </SelectField>
      <SelectField
        label="Date and number format"
        name="locale"
        value={locale}
        onChange={(e) => setLocale(e.target.value)}
        error={state.errors?.locale}
        hint={`For example ${formatExample(locale, timezone, currency)}`}
      >
        {SUPPORTED_LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_NAMES[l] ?? l}
          </option>
        ))}
      </SelectField>
      <p className="text-sm text-ink-muted">
        Your plan and billing are under{' '}
        <Link href="/settings/billing" className="underline">
          Subscription and billing
        </Link>
        .
      </p>
      <div className="flex items-center gap-3">
        <Button variant="primary" type="submit" disabled={pending}>
          Save profile
        </Button>
      </div>
      {state.status === 'saved' && <Alert tone="ok">Profile saved.</Alert>}
    </form>
  );
}
