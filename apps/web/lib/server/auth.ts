import 'server-only';
import { recordAudit, schema, withTenant } from '@tm/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { ipAddressOptions } from '../client-ip';
import { appDb, authDb } from './db';
import { serverEnv } from './env';
import { getMailer } from './mailer';

function createAuth() {
  const env = serverEnv();
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
      requireEmailVerification: true,
      minPasswordLength: 12,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await getMailer().send({
          to: user.email,
          subject: 'Reset your Trading Magician password',
          text: `Use this link to choose a new password. It expires in one hour.\n\n${url}\n\nIf you did not ask for this, ignore this email.`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
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
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await withTenant(appDb(), { userId: user.id }, (tx) =>
            recordAudit(tx, {
              userId: user.id,
              actorType: 'user',
              action: 'account.deleted',
              resourceType: 'user',
              resourceId: user.id,
            }),
          );
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
