let counter = 0;

/** Returns a short unique id. Uniqueness only needs to hold within one project. */
export function newId(prefix = ''): string {
  counter = (counter + 1) % 0x1000000;
  const rnd = Math.floor(Math.random() * 0x100000000)
    .toString(36)
    .padStart(7, '0');
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${rnd}`;
}
