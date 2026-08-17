import * as Crypto from "expo-crypto";

export function createId(): string {
  return Crypto.randomUUID();
}
