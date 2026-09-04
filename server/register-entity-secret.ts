// Run once, by hand: npm run register-entity-secret
//
// Generates a 32-byte entity secret and registers its ciphertext with Circle.
// Requires CIRCLE_API_KEY in server/.env. Writes CIRCLE_ENTITY_SECRET back to
// .env and saves a recovery file under ./recovery — never commit either.
// See https://developers.circle.com/wallets/dev-controlled/register-entity-secret

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";

const apiKey: string | undefined = process.env.CIRCLE_API_KEY;
if (!apiKey) {
  throw new Error("CIRCLE_API_KEY is required. Set it in server/.env first.");
}

// Refuse to overwrite an existing entity secret in .env.
const existingEnv: string = existsSync(".env") ? readFileSync(".env", "utf8") : "";
if (/^CIRCLE_ENTITY_SECRET=/m.test(existingEnv)) {
  throw new Error("CIRCLE_ENTITY_SECRET already exists in .env. Refusing to overwrite it.");
}

const entitySecret: string = randomBytes(32).toString("hex");
const recoveryFilePath: string = "./recovery";
mkdirSync(recoveryFilePath, { recursive: true });

await registerEntitySecretCiphertext({
  apiKey,
  entitySecret,
  recoveryFileDownloadPath: recoveryFilePath,
});

appendFileSync(".env", `\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`);

console.log("Entity secret registered.");
console.log(`Recovery file saved to a new file in: ${recoveryFilePath}`);
console.log("CIRCLE_ENTITY_SECRET added to .env");
