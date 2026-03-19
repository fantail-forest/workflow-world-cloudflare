import type { World } from "@workflow/world";
import type { WorkflowRunDO } from "./run-do.js";

const INSPECT_PREFIX = "/.well-known/workflow/v1/inspect";

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

function checkAuth(request: Request, inspectToken: string | undefined): Response | null {
  if (!inspectToken) {
    return new Response("Not Found", { status: 404 });
  }
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || authHeader !== `Bearer ${inspectToken}`) {
    return unauthorized();
  }
  return null;
}

function parseSearchParams(url: URL) {
  const limit = Number.parseInt(url.searchParams.get("limit") || "20", 10);
  const cursor = url.searchParams.get("cursor") || undefined;
  const workflowName = url.searchParams.get("workflowName") || undefined;
  const resolveData = (url.searchParams.get("resolveData") as "all" | "none") || "all";
  return { limit, cursor, workflowName, resolveData };
}

export type InspectRunDONamespace = DurableObjectNamespace<WorkflowRunDO>;

function searchParam(url: URL, key: string): string {
  return url.searchParams.get(key) || "";
}

/** Extract capture groups from a pattern match; returns null if no match. */
function matchCapture(subPath: string, pattern: RegExp): string[] | null {
  const m = subPath.match(pattern);
  if (!m) return null;
  return m.slice(1).map((g) => g ?? "");
}

async function dispatchInspectRoute(
  subPath: string,
  url: URL,
  world: World,
  runDO: InspectRunDONamespace | undefined,
): Promise<Response> {
  const { limit, cursor, workflowName, resolveData } = parseSearchParams(url);
  const pag = { limit, cursor, sortOrder: "desc" as const };

  if (subPath === "/runs") {
    return Response.json(await world.runs.list({ workflowName, resolveData, pagination: pag }));
  }

  const runParams = matchCapture(subPath, /^\/runs\/([^/]+)$/);
  if (runParams) {
    const [runId = ""] = runParams;
    return Response.json(await world.runs.get(runId, { resolveData }));
  }

  const stepsParams = matchCapture(subPath, /^\/runs\/([^/]+)\/steps$/);
  if (stepsParams) {
    const [runId = ""] = stepsParams;
    return Response.json(await world.steps.list({ runId, resolveData, pagination: pag }));
  }

  const stepParams = matchCapture(subPath, /^\/runs\/([^/]+)\/steps\/([^/]+)$/);
  if (stepParams) {
    const [runId = "", stepId = ""] = stepParams;
    return Response.json(await world.steps.get(runId, stepId, { resolveData }));
  }

  const eventsParams = matchCapture(subPath, /^\/runs\/([^/]+)\/events$/);
  if (eventsParams) {
    const [runId = ""] = eventsParams;
    return Response.json(await world.events.list({ runId, resolveData, pagination: pag }));
  }

  const streamsParams = matchCapture(subPath, /^\/runs\/([^/]+)\/streams$/);
  if (streamsParams) {
    const [runId = ""] = streamsParams;
    return Response.json({ data: await world.listStreamsByRunId(runId) });
  }

  if (subPath === "/hooks") {
    const runId = searchParam(url, "runId");
    return Response.json(await world.hooks.list({ runId, resolveData, pagination: pag }));
  }

  const hookParams = matchCapture(subPath, /^\/hooks\/([^/]+)$/);
  if (hookParams) {
    const [hookId = ""] = hookParams;
    return Response.json(await world.hooks.get(hookId, { resolveData }));
  }

  const storageParams = matchCapture(subPath, /^\/runs\/([^/]+)\/storage$/);
  if (storageParams) {
    if (!runDO) return Response.json({ error: "Storage stats not available" }, { status: 501 });
    const [runId = ""] = storageParams;
    const stats = await runDO.get(runDO.idFromName(runId)).storageStats();
    return Response.json({ runId, ...stats });
  }

  return new Response("Not Found", { status: 404 });
}

/**
 * Handle inspect HTTP requests. Returns a Response for matching paths,
 * or null if the path doesn't match the inspect prefix.
 *
 * All endpoints require `Authorization: Bearer <token>` matching the
 * WORKFLOW_INSPECT_TOKEN secret. If the secret is not configured,
 * all inspect endpoints return 404.
 */
export async function handleInspectRequest(
  request: Request,
  world: World,
  inspectToken: string | undefined,
  runDO?: InspectRunDONamespace,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith(INSPECT_PREFIX)) return null;
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  const authError = checkAuth(request, inspectToken);
  if (authError) return authError;
  try {
    return await dispatchInspectRoute(path.slice(INSPECT_PREFIX.length), url, world, runDO);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
