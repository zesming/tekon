/**
 * PD-10：角色 provider 覆盖值（model/effort/driver）的统一安全字符集。
 *
 * 这些值最终会进入子进程 argv。虽然 Tekon 网关以 argv 数组 spawn（无 shell），
 * 但 provider 自身的 argv 解析器是否会把一个以 `--` 开头、含空白或 Shell
 * 元字符的值解释成额外选项，Tekon 无法控制。这里用白名单做纵深防御，保证
 * 覆盖值只能是单一的、安全形状的标识符。
 *
 * 允许：小写/大写字母、数字、连字符、点、下划线；必须字母或数字开头，
 * 长度 1–64。覆盖常见厂商命名（gpt-4.1、claude-opts-5-5、low/medium/high、
 * 自定义模型代号），拒绝选项前缀、空白、路径分隔与任何 Shell 元字符。
 */
const SAFE_PROVIDER_OVERRIDE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertSafeProviderOverrideValue(
  field: 'model' | 'effort' | 'driver',
  value: string,
): void {
  if (!SAFE_PROVIDER_OVERRIDE_VALUE.test(value)) {
    throw new Error(
      `ROLE_OVERRIDE_INVALID: 角色 ${field} 含非法字符（${value}），只允许字母、数字、连字符、点和下划线，且须以字母或数字开头。`,
    );
  }
}

export function isSafeProviderOverrideValue(value: string): boolean {
  return SAFE_PROVIDER_OVERRIDE_VALUE.test(value);
}
