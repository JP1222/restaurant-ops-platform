import "./lib/sentry-init.js";
import { buildApp } from "./app.js";
import { createServices } from "./lib/services.js";

const services = createServices();
const app = await buildApp(services);

try {
  await app.listen({ port: services.config.apiPort, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
