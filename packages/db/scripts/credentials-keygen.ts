/**
 * Local development only: prints a new credential key pair as two env lines
 * (ADR 0015). Give CREDENTIALS_PUBLIC_KEY to the web app and
 * CREDENTIALS_PRIVATE_KEY to the worker only. Deployed environments keep the
 * private key in their secret manager.
 */
import { generateCredentialKeyPair } from '../src/sealed';

const { publicKey, privateKey } = generateCredentialKeyPair();
const oneLine = (pem: string) => pem.trim().replace(/\n/g, '\\n');
process.stdout.write(`CREDENTIALS_PUBLIC_KEY="${oneLine(publicKey)}"\n`);
process.stdout.write(`CREDENTIALS_PRIVATE_KEY="${oneLine(privateKey)}"\n`);
