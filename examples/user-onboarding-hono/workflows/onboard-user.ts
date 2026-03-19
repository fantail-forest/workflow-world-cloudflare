import { FatalError, sleep } from "workflow";
import { getCloudflareEnv } from "workflow-world-cloudflare";

interface OnboardingInput {
  email: string;
  simulateActivation?: boolean;
}

interface User {
  id: string;
  email: string;
}

export async function onboardUser(input: OnboardingInput) {
  "use workflow";

  const user = await createUser(input.email);
  await sendEmail(user, "welcome");

  await sleep("10s");
  await sendEmail(user, "onboarding-tips");

  await sleep("15s");
  const activated = await checkActivation(user.id, input.simulateActivation);

  if (activated) {
    await sendEmail(user, "celebration");
  } else {
    await sendEmail(user, "re-engagement");
  }

  const emailsSent = await getEmailLog(user.id);
  return { userId: user.id, activated, emailsSent };
}

async function createUser(email: string): Promise<User> {
  "use step";

  if (!email?.includes("@")) {
    throw new FatalError("Invalid email address");
  }

  const env = getCloudflareEnv<{ USERS: KVNamespace }>();
  const id = crypto.randomUUID();
  const user = { id, email };

  await env.USERS.put(
    id,
    JSON.stringify({
      ...user,
      activated: false,
      createdAt: new Date().toISOString(),
    }),
  );

  console.log(`User created: ${id} (${email})`);
  return user;
}

async function sendEmail(user: User, type: string): Promise<void> {
  "use step";

  console.log(`Sending ${type} email to ${user.email}...`);

  if (type === "welcome" && Math.random() < 0.3) {
    throw new Error("Email service temporarily unavailable");
  }

  const env = getCloudflareEnv<{ USERS: KVNamespace }>();
  const key = `emails:${user.id}`;
  const existing = (await env.USERS.get<string[]>(key, "json")) ?? [];
  existing.push(type);
  await env.USERS.put(key, JSON.stringify(existing));

  console.log(`${type} email sent to ${user.email}.`);
}

async function checkActivation(
  userId: string,
  simulateActivation?: boolean,
): Promise<boolean> {
  "use step";

  const env = getCloudflareEnv<{ USERS: KVNamespace }>();
  const record = await env.USERS.get<{ activated: boolean }>(userId, "json");
  const activated = simulateActivation ?? record?.activated ?? false;
  console.log(`Activation check for ${userId}: ${activated}`);
  return activated;
}

async function getEmailLog(userId: string): Promise<string[]> {
  "use step";

  const env = getCloudflareEnv<{ USERS: KVNamespace }>();
  return (await env.USERS.get<string[]>(`emails:${userId}`, "json")) ?? [];
}
