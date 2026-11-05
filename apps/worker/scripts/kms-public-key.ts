/**
 * Prints the public half of the AWS KMS credential key (ADR 0035), to set as
 * CREDENTIALS_PUBLIC_KEY on the web app, and its fingerprint, which the
 * worker logs at start-up and every sealed credential records:
 *
 *   CREDENTIALS_KMS_KEY_ID=arn:aws:kms:... AWS_REGION=us-east-1 \
 *     pnpm --filter @tm/worker credentials:kms-public-key
 *
 * Needs AWS credentials allowed kms:GetPublicKey on that key.
 */
import { awsKmsCalls, kmsKey } from '../src/credential-key';

const arn = process.env.CREDENTIALS_KMS_KEY_ID;
if (!arn) {
  process.stderr.write('Set CREDENTIALS_KMS_KEY_ID to the KMS key ARN\n');
  process.exit(1);
}
const key = await kmsKey(arn, awsKmsCalls(process.env.AWS_REGION));
process.stdout.write(`# fingerprint ${key.keyId}\n${key.publicKeyPem}`);
