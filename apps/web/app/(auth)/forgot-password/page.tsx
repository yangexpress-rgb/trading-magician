import Link from 'next/link';
import { ForgotPasswordForm } from '@/components/forgot-password-form';
import { serverEnv } from '@/lib/server/env';

export default function ForgotPasswordPage() {
  if (serverEnv().EMAIL_VERIFICATION === 'required') return <ForgotPasswordForm />;
  // The app sends no email (ADR 0036), so a reset link can't reach anyone.
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Reset your password</h1>
      <p>
        Trading Magician doesn&apos;t send email yet, so there is no reset link. Ask the person who
        invited you to reset your password. They will give you a temporary one to sign in with, and
        you can change it in Settings.
      </p>
      <Link href="/sign-in">Back to sign in</Link>
    </div>
  );
}
