import { getRun, start } from "workflow/api";
import { withWorkflow } from "workflow-world-cloudflare/with-workflow";
import { onboardUser } from "#workflows";

export default withWorkflow({
  async fetch(request: Request, _env: Record<string, unknown>, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/start" && request.method === "POST") {
      const body = (await request.json()) as { email: string; simulateActivation?: boolean };
      const run = await start(onboardUser, [body]);
      return Response.json({ runId: run.runId });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const runId = url.searchParams.get("runId");
      if (!runId) {
        return Response.json({ error: "Missing runId parameter" }, { status: 400 });
      }
      const run = getRun(runId);
      const status = await run.status;
      const output = status === "completed" ? await run.output : undefined;
      return Response.json({ runId, status, output });
    }

    return new Response("User Onboarding API\n\nPOST /start\nGET /status?runId=...", {
      headers: { "content-type": "text/plain" },
    });
  },
});
