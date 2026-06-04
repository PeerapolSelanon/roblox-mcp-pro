/**
 * Central tool registry — register every tool on the MCP server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSystemTools } from "./system.js";
import { registerExecuteTools } from "./execute.js";
import { registerInstanceTools } from "./instances.js";
import { registerSyncTools } from "./sync.js";
import { registerBatchTools } from "./batch.js";
import { registerSpatialTools } from "./spatial.js";
import { registerTerrainTools } from "./terrain.js";
import { registerUITools } from "./ui.js";
import { registerAudioTools } from "./audio.js";
import { registerAnimationTools } from "./animation.js";
import { registerWorldTools } from "./world.js";
import { registerBuildTools } from "./build.js";
import { registerStudioInfoTools } from "./studioInfo.js";
import { registerCaptureTools } from "./capture.js";

export function registerAllTools(server: McpServer): void {
  registerSystemTools(server);
  registerCaptureTools(server);
  registerExecuteTools(server);
  registerInstanceTools(server);
  registerSyncTools(server);
  registerBatchTools(server);
  registerSpatialTools(server);
  registerTerrainTools(server);
  registerUITools(server);
  registerAudioTools(server);
  registerAnimationTools(server);
  registerWorldTools(server);
  registerBuildTools(server);
  registerStudioInfoTools(server);
}
