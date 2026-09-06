import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { loadConfig } from "../lib/config";
import { createServiceClient, createSupabaseAttemptsStore } from "../lib/supabase";
import { registerScoreRoute } from "./routes/score";

export const buildApp = () => {
  const config = loadConfig();
  if (!config.hmacSecret) {
    throw new Error("MURMUR_HMAC_SECRET is missing");
  }
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const client = createServiceClient(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
  );
  const store = createSupabaseAttemptsStore(client);
  const app = Fastify({ logger: true });
  registerScoreRoute(app, { config, store });
  return { app, config };
};

const main = async () => {
  const { app, config } = buildApp();
  await app.listen({ port: config.port, host: "0.0.0.0" });
};

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
