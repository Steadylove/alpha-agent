import { loadLocalEnvironment } from "./env";

// Keep this import before modules which capture environment variables at load time.
loadLocalEnvironment();
