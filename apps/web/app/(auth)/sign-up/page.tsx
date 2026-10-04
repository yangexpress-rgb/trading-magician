'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Field } from '@/components/form-field';
import { authClient } from '@/lib/auth-client';

export default function SignUpPage() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email'));
    setPending(true);
    setError(undefined);
    const { error } = await authClient.signUp.email({
      name: String(form.get('name')),
      email,
      password: String(form.get('password')),
      callbackURL: '/strategy-lab',
    });
    setPending(false);
    if (error) {
      setError(error.message ?? 'Sign-up failed. Try again.');
      return;
    }
    router.push(`/check-email?email=${encodeURIComponent(email)}`);
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <h1>Create your account</h1>
      <Field label="Name" name="name" autoComplete="name" required maxLength={80} />
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Field
        label="Password (at least 12 characters)"
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
        {pending ? 'Creating account…' : 'Create account'}
      </button>
      <p>
        Already have an account? <Link href="/sign-in">Sign in</Link>
      </p>
    </form>
  );
}
