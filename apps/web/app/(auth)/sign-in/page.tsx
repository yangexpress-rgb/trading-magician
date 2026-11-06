'use client';

import { Alert, Button, TextField } from '@tm/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { authClient } from '@/lib/auth-client';

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(undefined);
    const { error } = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
      callbackURL: '/strategy-lab',
    });
    setPending(false);
    if (error) {
      setError(
        error.code === 'ACCOUNT_DELETED'
          ? 'This account has been deleted.'
          : error.code === 'ACCOUNT_LOCKED'
            ? 'This account is locked. Ask the person who invited you.'
            : error.status === 403
              ? 'Verify your email first. We sent you a new link.'
              : 'Email or password is incorrect.',
      );
      return;
    }
    router.push('/strategy-lab');
    router.refresh();
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <h1 className="text-xl font-semibold">Sign in</h1>
      {params.get('reset') === '1' && (
        <Alert tone="ok">Password changed. Sign in with your new password.</Alert>
      )}
      {params.get('deleted') === '1' && <Alert tone="ok">Your account was deleted.</Alert>}
      <TextField label="Email" name="email" type="email" autoComplete="email" required />
      <TextField
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      {error && <Alert>{error}</Alert>}
      <Button variant="primary" type="submit" className="w-full" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
      <p className="text-sm">
        <Link href="/forgot-password">Forgot your password?</Link>
      </p>
      <p className="text-sm">
        New here? <Link href="/sign-up">Create an account</Link>
      </p>
    </form>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
