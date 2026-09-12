/**
 * 密码强度估算：客户端 meter 与服务端强制校验共用的唯一实现。
 *
 * 策略取向 NIST SP 800-63B：长度下限 8、上限 128、不强制字符组合；
 * 以常见密码/序列/重复惩罚 + 长度档 + 字符类多样性估算 0–4 档（近似 zxcvbn 分档）。
 * 纯函数、确定性、无依赖，单测覆盖分档与惩罚边界。
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const MIN_ACCEPTABLE_STRENGTH = 2;

const COMMON_PASSWORD_FRAGMENTS = [
  "password",
  "123456",
  "12345678",
  "qwerty",
  "abc123",
  "iloveyou",
  "admin",
  "111111",
  "000000",
  "a123456",
] as const;

const SEQUENTIAL_PREFIXES = ["0123456789", "abcdefghij", "9876543210", "jihgfedcba"] as const;

function characterClasses(value: string): number {
  let classes = 0;
  if (/[a-z]/.test(value)) classes += 1;
  if (/[A-Z]/.test(value)) classes += 1;
  if (/[0-9]/.test(value)) classes += 1;
  if (/[^a-zA-Z0-9]/.test(value)) classes += 1;
  return classes;
}

function hasWeakPattern(value: string): boolean {
  const lowered = value.toLowerCase();
  if (COMMON_PASSWORD_FRAGMENTS.some((fragment) => lowered.includes(fragment))) return true;
  if (/^(.)\1+$/.test(value)) return true;
  return SEQUENTIAL_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

/** 0–4 档强度分：0 空、1 弱（过短/命中弱模式）、2–4 递增。 */
export function passwordStrengthScore(value: string): number {
  if (!value) return 0;
  if (value.length < PASSWORD_MIN_LENGTH) return 1;
  if (hasWeakPattern(value)) return 1;
  let score = value.length >= 16 ? 3 : value.length >= 12 ? 2 : 1;
  if (characterClasses(value) >= 3) score += 1;
  return Math.min(4, score);
}

export function isPasswordLengthAcceptable(value: string): boolean {
  return value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH;
}

/** 服务端强制与客户端提交门槛：长度合规且强度 ≥ MIN_ACCEPTABLE_STRENGTH。 */
export function isPasswordAcceptable(value: string): boolean {
  return (
    isPasswordLengthAcceptable(value) && passwordStrengthScore(value) >= MIN_ACCEPTABLE_STRENGTH
  );
}
