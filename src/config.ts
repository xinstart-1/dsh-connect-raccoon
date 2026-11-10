/**
 * 插件配置：用户在设置页 / `cordis.patch.yml` 里填的东西。
 *
 * 默认值只写在 schema 里，`apply` 内不再兜底 —— 两份默认值就是两次真相。
 *
 * @module dsh-connect-raccoon/config
 */

import z from '@deepseek-ai/schemastery';

/** 配置 schema 与默认值。 */
export const Config = z.object({
  /** 是否启用小浣熊路由（关掉即从模型选择器里撤掉）。 */
  enabled: z
    .boolean()
    .description('在 DSH 模型选择器里启用商汤小浣熊。')
    .default(true),

  /** 主站地址；只有换测试环境时才需要改。 */
  siteOrigin: z
    .string()
    .description('小浣熊主站。留空用内置 https://xiaohuanxiong.com，只有测试环境需要改。')
    .default(''),

  /**
   * 复用本机桌面端的登录态。
   *
   * 关掉后插件只用自己的账号池，一个字节都不碰桌面端文件。
   */
  reuseDesktop: z
    .boolean()
    .description('自动读取本机小浣熊桌面端的登录态（只读复用；令牌轮转时会原子写回）。')
    .default(true),

  /**
   * 允许把轮转后的令牌写回桌面端文件。
   *
   * 关掉 = 纯只读：刷新令牌只更插件自己的副本，桌面端会因 `refresh_conflict`
   * 被登出一次，所以要由用户显式选择。
   */
  writeBackDesktop: z
    .boolean()
    .description('刷新令牌后把轮转结果写回桌面端 auth.json（不写回会导致客户端下次刷新冲突掉登录）。')
    .default(true),

  /** 启动时预热一次目录与账号状态。 */
  warmOnStart: z
    .boolean()
    .description('插件启动时预拉一次模型目录与账号状态，让卡片与选择器更快显示真实数据。')
    .default(true),

  /** 默认思考档位（模型未声明时兜底）。 */
  defaultReasoningEffort: z
    .string()
    .description('默认思考档位：off / low / medium / high / max。留空沿用上游默认。')
    .default(''),

  /**
   * 换号时的最大尝试次数。
   *
   * 上限存在是为了「一个都不通时不把整池账号轮流打一遍」：那既慢又会把
   * 一池账号全打进限流。
   */
  maxFailoverAttempts: z
    .number()
    .description('一次请求最多换几个账号重试（1 表示不换号）。')
    .default(3),
});

/** 解析后的配置类型。 */
export interface RaccoonConfig {
  enabled: boolean;
  siteOrigin: string;
  reuseDesktop: boolean;
  writeBackDesktop: boolean;
  warmOnStart: boolean;
  defaultReasoningEffort: string;
  maxFailoverAttempts: number;
}

/** 缺省值：直接跑 schema 得到，不手写第二份。 */
export const DEFAULT_CONFIG: RaccoonConfig = Config({}) as RaccoonConfig;
