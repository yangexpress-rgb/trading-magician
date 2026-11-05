import { SignUpForm } from '@/components/sign-up-form';
import { serverEnv } from '@/lib/server/env';

export default function SignUpPage() {
  return <SignUpForm inviteRequired={serverEnv().SIGNUP_MODE === 'invite'} />;
}
