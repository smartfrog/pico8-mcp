/** Button names <-> PICO-8 bitmask (player 0). */

export const BUTTON_BITS: Record<string, number> = {
  left: 0,
  right: 1,
  up: 2,
  down: 3,
  o: 4, // btn(4) — O button (Z/C on keyboard), typically jump
  x: 5, // btn(5) — X button, typically dash/action
};

export const BUTTON_NAMES = Object.keys(BUTTON_BITS);

export function buttonsToMask(buttons: string[] | undefined): number {
  if (!buttons) return 0;
  let mask = 0;
  for (const b of buttons) {
    const key = b.toLowerCase();
    const bit = BUTTON_BITS[key];
    if (bit === undefined) {
      throw new Error(`unknown button "${b}" (valid: ${BUTTON_NAMES.join(", ")})`);
    }
    mask |= 1 << bit;
  }
  return mask;
}

export function maskToButtons(mask: number): string[] {
  return BUTTON_NAMES.filter((n) => mask & (1 << BUTTON_BITS[n]));
}
