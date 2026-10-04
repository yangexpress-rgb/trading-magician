'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Field } from '@/components/form-field';
import { authClient } from '@/lib/auth-client';

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    await authClient.requestPasswordReset({
      email: String(form.get('email')),
      redirectTo: '/reset-password',
    });
    setPending(false);
    // Same message whether or not the account exists, so emails can't be probed.
    setSent(true);
  }

  if (sent) {
    return (
      <div className="stack">
        <h1>Check your email</h1>
        <p>If an account exists for that address, we sent a link to reset the password.</p>
        <Link href="/sign-in">Back to sign in</Link>
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <h1>Reset your password</h1>
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <button className="primary" type="submit" disabled={pending}>
        Send reset link
      </button>
      <Link href="/sign-in">Back to sign in</Link>
    </form>
  );
}
