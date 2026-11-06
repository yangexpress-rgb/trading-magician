import { SignUpForm } from '@/components/sign-up-form';
import { serverEnv } from '@/lib/server/env';

export default function SignUpPage() {
  const env = serverEnv();
  return (
    <SignUpForm
      inviteRequired={env.SIGNUP_MODE === 'invite'}
      verifyEmail={env.EMAIL_VERIFICATION === 'required'}
    />
  );
}
