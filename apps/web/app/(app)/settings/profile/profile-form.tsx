'use client';

import { Alert, Button, SelectField, TextField } from '@tm/ui';
import { useActionState } from 'react';
import { COMMON_CURRENCIES, SUPPORTED_LOCALES } from '@/lib/profile';
import { updateProfile, type ProfileFormState } from './actions';

interface Props {
  profile: { displayName: string; timezone: string; baseCurrency: string; locale: string };
  timezones: string[];
}

export function ProfileForm({ profile, timezones }: Props) {
  const [state, action, pending] = useActionState<ProfileFormState, FormData>(updateProfile, {
    status: 'idle',
  });
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
        defaultValue={profile.timezone}
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
        defaultValue={profile.baseCurrency}
        error={state.errors?.baseCurrency}
      >
        {currencies.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </SelectField>
      <SelectField
        label="Date and number format"
        name="locale"
        defaultValue={profile.locale}
        error={state.errors?.locale}
      >
        {SUPPORTED_LOCALES.map((l) => (
          <option key={l}>{l}</option>
        ))}
      </SelectField>
      <div className="flex items-center gap-3">
        <Button variant="primary" type="submit" disabled={pending}>
          Save profile
        </Button>
      </div>
      {state.status === 'saved' && <Alert tone="ok">Profile saved.</Alert>}
    </form>
  );
}
