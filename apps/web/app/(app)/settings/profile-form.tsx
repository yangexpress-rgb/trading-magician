'use client';

import { useActionState } from 'react';
import { Field } from '@/components/form-field';
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
    <form action={action} className="stack" aria-label="Profile">
      <Field
        label="Display name"
        name="displayName"
        defaultValue={profile.displayName}
        error={state.errors?.displayName}
        required
      />
      <div>
        <label htmlFor="timezone">Time zone</label>
        <select id="timezone" name="timezone" defaultValue={profile.timezone}>
          {timezones.map((tz) => (
            <option key={tz}>{tz}</option>
          ))}
        </select>
        {state.errors?.timezone && <p className="error">{state.errors.timezone}</p>}
      </div>
      <div>
        <label htmlFor="baseCurrency">Base currency</label>
        <select id="baseCurrency" name="baseCurrency" defaultValue={profile.baseCurrency}>
          {currencies.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="locale">Date and number format</label>
        <select id="locale" name="locale" defaultValue={profile.locale}>
          {SUPPORTED_LOCALES.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </div>
      <button className="primary" type="submit" disabled={pending}>
        Save profile
      </button>
      {state.status === 'saved' && (
        <p role="status" className="success">
          Profile saved.
        </p>
      )}
    </form>
  );
}
