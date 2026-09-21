'use strict';

/**
 * Cheap USB/keyboard-wedge NFC readers do not agree on how to spell a tag.
 * The same keychain fob can arrive as "04:A2:1B:3C", "04A21B3C", its
 * byte-reversed twin "3C1BA204", or as the decimal number "0077928450".
 * We store one normalized form but look a tag up by every plausible spelling,
 * so a fob enrolled on one reader still works on the next.
 */

/** Uppercase, strip separators and the leading zeros decimal readers pad with. */
function normalizeUid(raw) {
  if (raw === null || raw === undefined) return '';
  const cleaned = String(raw).replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
  if (!cleaned) return '';
  if (/^\d+$/.test(cleaned)) return cleaned.replace(/^0+(?=\d)/, '');
  return cleaned;
}

const isHex = (s) => /^[0-9A-F]+$/.test(s) && s.length % 2 === 0;
const isDecimal = (s) => /^\d+$/.test(s);

/** Swap byte order: "04A21B3C" -> "3C1BA204". */
function reverseBytes(hex) {
  const bytes = hex.match(/../g) || [];
  return bytes.reverse().join('');
}

function decimalToHex(decimal) {
  try {
    const hex = BigInt(decimal).toString(16).toUpperCase();
    return hex.length % 2 ? `0${hex}` : hex;
  } catch {
    return null;
  }
}

function hexToDecimal(hex) {
  try {
    return BigInt(`0x${hex}`).toString(10);
  } catch {
    return null;
  }
}

/**
 * Every spelling of a scanned tag worth checking against the database,
 * most likely first. Always includes the normalized input.
 */
function uidVariants(raw) {
  const base = normalizeUid(raw);
  if (!base) return [];
  const out = [base];
  const push = (v) => {
    if (v && !out.includes(v)) out.push(v);
  };

  if (isDecimal(base)) {
    const hex = decimalToHex(base);
    if (hex) {
      push(hex);
      push(hex.padStart(8, '0'));
      push(reverseBytes(hex.padStart(8, '0')));
    }
  } else if (isHex(base)) {
    push(reverseBytes(base));
    push(hexToDecimal(base));
    push(hexToDecimal(reverseBytes(base)));
  }
  return out;
}

module.exports = { normalizeUid, uidVariants, reverseBytes };
