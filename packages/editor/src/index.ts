/**
 * @autoeditor/editor — componente React montable del autoeditor de video con IA.
 *
 *   import { AutoEditor } from "@autoeditor/editor";
 *   import "@autoeditor/editor/styles.css";
 *   <AutoEditor apiBaseUrl="/api/v1" />
 */
export { AutoEditor, type AutoEditorProps } from "./AutoEditor.js";
export { createApiClient, unwrap } from "./api/client.js";
export { ApiRequestError, messageOf } from "./api/errors.js";
export { parseSseChunk } from "./api/sse.js";
export type { ApiClient, ApiClientOptions, EventSubscription, HeadersInput, StreamStatus, SubscribeOptions, UploadOptions } from "./api/types.js";
export { createDemoApi } from "./demo/demoApi.js";
export type { AutoEditorEvent } from "./store/controller.js";
export { buildGraph, type Graph, type GraphEdge, type GraphInput, type GraphNode } from "./canvas/buildGraph.js";
export { layoutGraph, findOverlaps } from "./canvas/layout.js";
export { STAGE_ORDER, STAGE_TITLES, type StageId } from "./lib/stages.js";
