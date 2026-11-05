'use client';

import { Alert, Button, TextField } from '@tm/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { authClient } from '@/lib/auth-client';

function ResetForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  if (!token || params.get('error')) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Link expired</h1>
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
    <form className="space-y-4" onSubmit={onSubmit}>
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      <TextField
        label="New password (at least 12 characters)"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={12}
        required
      />
      {error && <Alert>{error}</Alert>}
      <Button variant="primary" type="submit" className="w-full" disabled={pending}>
        Save password
      </Button>
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
