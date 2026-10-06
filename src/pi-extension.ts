import { createActlumePiExtension, type PiBridgeConfig } from "./pi-runtime.js";

const serializedConfig = process.env.ACTLUME_PI_BRIDGE_CONFIG;
if (!serializedConfig) {
  throw new Error("Actlume did not provide the Pi bridge configuration.");
}

const config = JSON.parse(serializedConfig) as PiBridgeConfig;
export default createActlumePiExtension(config);
