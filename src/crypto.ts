function base64Decode(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const buf = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const TOKEN_ENCRYPTION_KEY_ERROR =
  'Invalid TOKEN_ENCRYPTION_KEY configuration: expected a valid base64-encoded 32-byte (256-bit) AES key.';

function decodeTokenEncryptionKey(base64Key: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64Key)) {
    throw new Error(TOKEN_ENCRYPTION_KEY_ERROR);
  }

  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = base64Decode(base64Key);
  } catch {
    throw new Error(TOKEN_ENCRYPTION_KEY_ERROR);
  }

  if (keyBytes.byteLength !== 32) {
    throw new Error(TOKEN_ENCRYPTION_KEY_ERROR);
  }

  return keyBytes;
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const keyBytes = decodeTokenEncryptionKey(base64Key);
  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptToken(
  plaintext: string,
  base64Key: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded,
  );
  return {
    ciphertext: base64Encode(new Uint8Array(ciphertext)),
    iv: base64Encode(iv),
  };
}

export async function decryptToken(
  ciphertext: string,
  iv: string,
  base64Key: string,
): Promise<string> {
  const key = await importKey(base64Key);
  const ctBytes = base64Decode(ciphertext);
  const ivBytes = base64Decode(iv);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes },
    key,
    ctBytes,
  );
  return new TextDecoder().decode(decrypted);
}
