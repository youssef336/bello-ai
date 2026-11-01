// Usage: npm run hash-password -- "my password"
// Prints the value for the OWNER_PASSWORD_HASH secret. Same format as src/auth.ts.
const password = process.argv[2];
if (!password || password.length < 12) {
  console.error('Give a password of at least 12 characters: npm run hash-password -- "..."');
  process.exit(1);
}
const iterations = 100_000;
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
const b64 = (b) => Buffer.from(b).toString('base64');
console.log(`pbkdf2$sha256$${iterations}$${b64(salt)}$${b64(new Uint8Array(bits))}`);
