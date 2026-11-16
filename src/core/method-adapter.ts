type Method = (this: unknown, ...args: unknown[]) => unknown;
type Handler = (receiver: unknown, original: Method, args: unknown[]) => unknown;

/** A later plugin may retain this wrapper; disposal makes it an inert delegate. */
export function adaptMethod(object: object, key: string, handler: Handler): () => void {
  const original = Reflect.get(object, key) as unknown;
  if (typeof original !== "function") throw new Error(`Unsupported native method: ${key}`);
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  let active: Handler | null = handler;
  const wrapper: Method = function (...args) {
    const current = active;
    return current ? current(this, original as Method, args) : Reflect.apply(original, this, args);
  };
  Reflect.set(object, key, wrapper);
  return () => {
    active = null;
    if (Reflect.get(object, key) !== wrapper) return;
    if (descriptor) Object.defineProperty(object, key, descriptor);
    else Reflect.deleteProperty(object, key);
  };
}
