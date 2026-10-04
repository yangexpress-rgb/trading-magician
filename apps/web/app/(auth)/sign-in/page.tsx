'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Field } from '@/components/form-field';
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
        error.status === 403
          ? 'Verify your email first. We sent you a new link.'
          : 'Email or password is incorrect.',
      );
      return;
    }
    router.push('/strategy-lab');
    router.refresh();
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <h1>Sign in</h1>
      {params.get('reset') === '1' && (
        <p className="success">Password changed. Sign in with your new password.</p>
      )}
      {params.get('deleted') === '1' && <p className="success">Your account was deleted.</p>}
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button className="primary" type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
      <p>
        <Link href="/forgot-password">Forgot your password?</Link>
      </p>
      <p>
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
