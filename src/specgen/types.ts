import type { ToolContext } from './context.js';
import type { ToolResult } from './dispatch.js';

export interface CuratedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (
    ctx: ToolContext,
    args: Record<string, unknown>
  ) => Promise<ToolResult>;
  /** Skip the argument-shape gate. Only for tools whose contract is to never
   *  return an error result (the ALP write tools): an unknown key there is
   *  ignored by the handler rather than rejected, by design. */
  lenientArguments?: boolean;
}
