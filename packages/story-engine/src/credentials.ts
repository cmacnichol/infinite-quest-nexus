import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type EncryptedCredential = {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: number;
};

function encryptionKey(secret: string): Buffer {
  if (!secret.trim()) throw Object.assign(new Error("Provider credentials require CREDENTIAL_ENCRYPTION_KEY or CREDENTIAL_ENCRYPTION_KEY_FILE."), { statusCode: 503 });
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptCredential(value: string, secret: string): EncryptedCredential {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: 1
  };
}

export function decryptCredential(value: EncryptedCredential, secret: string): string {
  if (value.keyVersion !== 1) throw new Error(`Unsupported provider credential key version ${value.keyVersion}.`);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(value.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(value.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}
