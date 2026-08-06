/**
 * 能力分级模型(PRD §1.2):
 * - L0 观察:只读调查、问答
 * - L1 编写:隔离工作区内写代码、跑测试、commit
 * - L2 交付:push pinery/* 分支、创建 PR(显式确认)
 * - L3 危险:merge/部署/改 CI,默认禁用,白名单 + 审批
 */
export type PermissionLevel = 0 | 1 | 2 | 3;

export const LEVEL_NAMES: Record<PermissionLevel, string> = {
  0: "L0 观察",
  1: "L1 编写",
  2: "L2 交付",
  3: "L3 危险",
};

export function isPermissionLevel(n: number): n is PermissionLevel {
  return n === 0 || n === 1 || n === 2 || n === 3;
}
