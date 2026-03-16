import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isCompiled = __dirname.includes(path.sep + "dist");
const envPath = path.join(__dirname, isCompiled ? "../../.env" : "../.env");

dotenv.config({
  path: envPath,
  override: false,
});

const serverEntry = isCompiled ? "./src/server.js" : "./src/server.ts";
await import(serverEntry);
