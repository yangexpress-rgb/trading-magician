'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Field } from '@/components/form-field';
import { authClient } from '@/lib/auth-client';

function ResetForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  if (!token || params.get('error')) {
    return (
      <div className="stack">
        <h1>Link expired</h1>
        <p>This reset link is invalid or has expired.</p>
        <Link href="/forgot-password">Request a new link</Link>
      </div>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    const { error } = await authClient.resetPassword({
      newPassword: String(form.get('password')),
      token: token as string,
    });
    setPending(false);
    if (error) {
      setError(error.message ?? 'Could not reset the password.');
      return;
    }
    router.push('/sign-in?reset=1');
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <h1>Choose a new password</h1>
      <Field
        label="New password (at least 12 characters)"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={12}
        required
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button className="primary" type="submit" disabled={pending}>
        Save password
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
