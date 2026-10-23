import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class CredentialCipher {
  constructor(private key: Buffer) {}
  encrypt(value: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from("stiva:credential:v1"));
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [
      "v1",
      nonce.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      encrypted.toString("base64"),
    ].join(":");
  }
  decrypt(value: string) {
    const [version, nonce, tag, ciphertext] = value.split(":");
    if (version !== "v1" || !nonce || !tag || !ciphertext)
      throw new Error("Invalid encrypted credential");
    const cipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(nonce, "base64"));
    cipher.setAAD(Buffer.from("stiva:credential:v1"));
    cipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      cipher.update(Buffer.from(ciphertext, "base64")),
      cipher.final(),
    ]).toString("utf8");
  }
  clear() {
    this.key.fill(0);
  }
}
