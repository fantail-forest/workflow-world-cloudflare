import { Hono } from "hono";
import { getRun, start } from "workflow/api";
import { withWorkflow } from "workflow-world-cloudflare/with-workflow";
import { onboardUser } from "../workflows/onboard-user";

const app = new Hono();

app.post("/start", async (c) => {
  const body = await c.req.json<{ email: string; simulateActivation?: boolean }>();
  const run = await start(onboardUser, [body]);
  return c.json({ runId: run.runId });
});

app.get("/status", async (c) => {
  const runId = c.req.query("runId");
  if (!runId) {
    return c.json({ error: "Missing runId parameter" }, 400);
  }
  const run = getRun(runId);
  const status = await run.status;
  const output = status === "completed" ? await run.output : undefined;
  return c.json({ runId, status, output });
});

app.get("/", (c) => {
  return c.text("User Onboarding API\n\nPOST /start\nGET /status?runId=...");
});

export default withWorkflow(app);
