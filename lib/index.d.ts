import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
/** 解析后的配置类型。 */
interface RaccoonConfig {
  enabled: boolean;
  siteOrigin: string;
  reuseDesktop: boolean;
  writeBackDesktop: boolean;
  warmOnStart: boolean;
  defaultReasoningEffort: string;
  maxFailoverAttempts: number;
}
/** 插件名（Cordis 用它做诊断前缀）。 */
declare const name = "dsh-connect-raccoon";
/** 依赖的服务：没有 llm 就没有模型路由可注册。 */
declare const inject: string[];
/**
 * 插件应用函数。
 *
 * @param ctx - Cordis 上下文。
 * @param rawConfig - 用户在设置页填的配置。
 */
declare function apply(ctx: Context, rawConfig: RaccoonConfig): Promise<void>;
export { apply, inject, name };