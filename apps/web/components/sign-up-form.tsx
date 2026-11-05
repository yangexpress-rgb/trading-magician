'use client';

import { Alert, Button, TextField } from '@tm/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { authClient } from '@/lib/auth-client';

export function SignUpForm({ inviteRequired }: { inviteRequired: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email'));
    setPending(true);
    setError(undefined);
    const inviteCode = String(form.get('inviteCode') ?? '').trim();
    const { error } = await authClient.signUp.email({
      name: String(form.get('name')),
      email,
      password: String(form.get('password')),
      callbackURL: '/strategy-lab',
      ...(inviteCode ? { inviteCode } : {}),
    });
    setPending(false);
    if (error) {
      setError(error.message ?? 'Sign-up failed. Try again.');
      return;
    }
    router.push(`/check-email?email=${encodeURIComponent(email)}`);
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <h1 className="text-xl font-semibold">Create your account</h1>
      <TextField label="Name" name="name" autoComplete="name" required maxLength={80} />
      {inviteRequired && (
        <TextField
          label="Invite code"
          name="inviteCode"
          autoComplete="off"
          autoCapitalize="characters"
          required
          maxLength={32}
          hint="Trading Magician is invite-only while it is new. Your code came with your invitation."
        />
      )}
      <TextField label="Email" name="email" type="email" autoComplete="email" required />
      <TextField
        label="Password (at least 12 characters)"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={12}
        required
      />
      {error && <Alert>{error}</Alert>}
      <Button variant="primary" type="submit" className="w-full" disabled={pending}>
        {pending ? 'Creating account…' : 'Create account'}
      </Button>
      <p className="text-sm">
        Already have an account? <Link href="/sign-in">Sign in</Link>
      </p>
      <p className="text-xs text-ink-muted">
        Paper trading only: no real money and no real orders. By creating an account you accept the{' '}
        <Link href="/terms">Terms of Service</Link> and <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </form>
  );
}
