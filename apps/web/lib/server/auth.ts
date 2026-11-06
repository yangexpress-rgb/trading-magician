import 'server-only';
import { eq, schema } from '@tm/db';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { ipAddressOptions } from '../client-ip';
import { authDb } from './db';
import { serverEnv } from './env';
import { getMailer } from './mailer';

function createAuth() {
  const env = serverEnv();
  const verifyEmail = env.EMAIL_VERIFICATION === 'required';
  return betterAuth({
    appName: 'Trading Magician',
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(authDb(), {
      provider: 'pg',
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        rateLimit: schema.rateLimits,
      },
    }),
    advanced: {
      database: { generateId: 'uuid' },
      useSecureCookies: env.APP_URL.startsWith('https://'),
      ipAddress: ipAddressOptions(env),
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: verifyEmail,
      minPasswordLength: 12,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        // No mail service (EMAIL_VERIFICATION=off): nothing to send the link with.
        if (!verifyEmail) return;
        await getMailer().send({
          to: user.email,
          subject: 'Reset your Trading Magician password',
          text: `Use this link to choose a new password. It expires in one hour.\n\n${url}\n\nIf you did not ask for this, ignore this email.`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: verifyEmail,
      sendOnSignIn: verifyEmail,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        if (!verifyEmail) return;
        await getMailer().send({
          to: user.email,
          subject: 'Verify your Trading Magician email',
          text: `Confirm your email address to finish signing up.\n\n${url}`,
        });
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 15,
    },
    // Deleting an account is the app's own action (lib/server/account-deletion.ts):
    // it marks the account and keeps order and audit records for the retention
    // period (§20 #14), which the library's immediate delete would not.
    user: { deleteUser: { enabled: false } },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const [user] = await authDb()
              .select({ deletedAt: schema.users.deletedAt })
              .from(schema.users)
              .where(eq(schema.users.id, session.userId));
            if (user?.deletedAt) {
              throw new APIError('FORBIDDEN', {
                code: 'ACCOUNT_DELETED',
                message: 'This account has been deleted.',
              });
            }
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 3 },
        '/send-verification-email': { window: 60, max: 3 },
      },
    },
    plugins: [nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;
const globalForAuth = globalThis as unknown as { tmAuth?: Auth };
export const auth = (): Auth => (globalForAuth.tmAuth ??= createAuth());
