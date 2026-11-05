'use client';

import { Button } from '@tm/ui';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button
      size="sm"
      onClick={async () => {
        await authClient.signOut();
        router.push('/sign-in');
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
