/**
 * 账号池的挑选逻辑（纯函数，不碰磁盘、不发请求）。
 *
 * 规则与理由：
 * 1. **池开关关着 → 永远用「当前选用」那个**。用户手动选谁是明确意图，自动挑不能盖过它。
 * 2. **池开着 → 只在勾选了参与的账号里挑**。没勾的即使条件更好也不碰。
 * 3. **勾选名单为空 → 什么都不挑**，退回当前选用。空名单不等于「全选」。
 * 4. **不可用不算候选**：冷却中、令牌过期、明确被上游拒绝的账号跳过，
 *    但「读不到余额」不算不可用 —— 一次网络抖动不该把好账号踢出池子。
 *
 * 排序键（依次比较）：可用 → 快过期先花 → 积分高 → 凭据新。
 * 「快过期先花」排在「积分高」之前，因为过期作废的额度是纯损失。
 *
 * @module dsh-connect-raccoon/host/pool
 */

/** 挑选用的一个候选账号。 */
export interface PoolCandidate {
  /** 账号稳定 id。 */
  id: string;
  /** 用户是否勾选它参与自动挑选。 */
  inPool: boolean;
  /** 此刻能不能拿它发请求（令牌未过期、不在冷却、上次探测不是硬失败）。 */
  usable: boolean;
  /** 不可用的分类原因，给界面看。 */
  reason?: string;
  /** 剩余积分；`undefined` 表示**读不到**（不是 0）。 */
  credits: number | undefined;
  /** 最近到期的那份额度的时间（毫秒）；`undefined` 表示没有到期额度。 */
  nearestExpiryMs: number | undefined;
  /** 凭据自身的到期时间（毫秒）；用于「凭据新」这一键。 */
  expiresAtMs: number;
}

/** 挑选结果。 */
export interface PoolChoice {
  /** 选中的账号 id，或 `undefined`（没有可挑的）。 */
  id: string | undefined;
  /** 为什么选它 / 为什么不选；界面直接显示这句。 */
  reason: string;
}

/**
 * 逐个候选排序；返回新数组，不改输入。
 *
 * 注意：两个调用方（{@link pickAccount} 与 {@link failoverCandidates}）都**先过滤掉不可用**，
 * 所以第一条比较键在当前调用图里走不到。仍然保留它是有意的 —— `rank` 是纯函数，
 * 将来若有调用方直接传全量候选，「不可用排最后」这个不变量应当自动成立，
 * 而不是要那个人再读一遍调用方代码。**不要**把它当成当前的可用性防线。
 *
 * @param candidates - 候选账号（可含不可用的）。
 * @param nowMs - 当前时间，用于「30 天内到期」判定。
 * @returns 排序后的新数组。
 */
function rank(candidates: readonly PoolCandidate[], nowMs: number): PoolCandidate[] {
  return [...candidates].sort((left, right) => {
    if (left.usable !== right.usable) return left.usable ? -1 : 1;
    // 30 天内到期的额度优先花掉；两侧都在 30 天内则更早到期者优先。
    const horizon = 30 * 24 * 3600_000;
    const leftExpiring = left.nearestExpiryMs !== undefined && left.nearestExpiryMs - nowMs <= horizon;
    const rightExpiring = right.nearestExpiryMs !== undefined && right.nearestExpiryMs - nowMs <= horizon;
    if (leftExpiring !== rightExpiring) return leftExpiring ? -1 : 1;
    if (leftExpiring && rightExpiring) {
      const delta = (left.nearestExpiryMs ?? 0) - (right.nearestExpiryMs ?? 0);
      if (delta !== 0) return delta;
    }
    const leftKnown = left.credits !== undefined;
    const rightKnown = right.credits !== undefined;
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    if (leftKnown && rightKnown) {
      const delta = (right.credits ?? 0) - (left.credits ?? 0);
      if (delta !== 0) return delta;
    }
    return right.expiresAtMs - left.expiresAtMs;
  });
}

/**
 * 从池里挑一个账号。
 *
 * @param input.poolEnabled - 账号池总开关。
 * @param input.currentId - 用户手动选定的账号 id（可能已被删除）。
 * @param input.candidates - 池里全部账号（顺序不影响结果）。
 * @param input.nowMs - 当前时间（注入以便测试）。
 * @returns 选中的 id 与一句给用户看的原因。
 */
export function pickAccount(input: {
  poolEnabled: boolean;
  currentId: string | undefined;
  candidates: readonly PoolCandidate[];
  nowMs?: number;
}): PoolChoice {
  const nowMs = input.nowMs ?? Date.now();
  const { candidates, currentId, poolEnabled } = input;

  if (candidates.length === 0) return { id: undefined, reason: '账号池是空的' };

  if (!poolEnabled) {
    const current = candidates.find((candidate) => candidate.id === currentId);
    if (current === undefined) {
      return {
        id: undefined,
        reason: currentId === undefined ? '还没有选定账号' : '选定的账号已不在本机',
      };
    }
    if (!current.usable) {
      return { id: current.id, reason: current.reason ?? '当前选用的账号此刻不可用' };
    }
    return { id: current.id, reason: '账号池未启用，使用当前选用的账号' };
  }

  const enabled = candidates.filter((candidate) => candidate.inPool && candidate.usable);
  if (enabled.length === 0) {
    const anyMember = candidates.some((candidate) => candidate.inPool);
    return {
      id: undefined,
      reason: anyMember ? '账号池里的账号此刻都不可用' : '账号池已启用，但没有勾选任何账号',
    };
  }

  const best = rank(enabled, nowMs)[0];
  if (best === undefined) return { id: undefined, reason: '没有可用账号' };
  const credits = best.credits;
  return {
    id: best.id,
    reason:
      credits === undefined
        ? `池内 ${String(enabled.length)} 个可用账号中按排序取第一个（余额读不到，未参与比较）`
        : `余额 ${String(credits)}，在池内 ${String(enabled.length)} 个可用账号里排序第一`,
  };
}

/**
 * 换号重试时的候选序列。
 *
 * 先排好序，再按顺序给出**除首个之外**的可用账号；首个由 {@link pickAccount} 决定，
 * 这里只回答「第一个不行之后该试谁」。
 *
 * @param input - 与 {@link pickAccount} 相同的池状态，外加首个账号 id。
 * @returns 依次尝试的账号 id 列表（不含首个）。
 */
export function failoverCandidates(input: {
  poolEnabled: boolean;
  currentId: string | undefined;
  candidates: readonly PoolCandidate[];
  firstId: string | undefined;
  nowMs?: number;
}): string[] {
  if (!input.poolEnabled) return [];
  const nowMs = input.nowMs ?? Date.now();
  return rank(
    input.candidates.filter((candidate) => candidate.inPool && candidate.usable),
    nowMs,
  )
    .map((candidate) => candidate.id)
    .filter((id) => id !== input.firstId);
}
