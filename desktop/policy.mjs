export function isLocal(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
export function isExternal(url) {
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
