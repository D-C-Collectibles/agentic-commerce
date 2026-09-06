// #auth-route — see .purpose in this directory.
//
// POST /auth/signup and POST /auth/login. Both return { token, user } on success.
// Emits !user-registered / !user-logged-in.

import { Router } from "express";
import { asyncHandler } from "../async-handler.js";
import { authenticateUser, createUser, isValidEmail } from "../services/auth.js";

export const authRouter = Router();

const MIN_PASSWORD_LENGTH = 6;

// Validate a { email, password } body; returns the pair or an error code.
function readCredentials(body: unknown): { email: string; password: string } | { error: string } {
  const { email, password } = (body ?? {}) as { email?: unknown; password?: unknown };
  if (typeof email !== "string" || !isValidEmail(email)) {
    return { error: "invalid_email" };
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return { error: "weak_password" };
  }
  return { email, password };
}

authRouter.post(
  "/auth/signup",
  asyncHandler(async (req, res) => {
    const creds = readCredentials(req.body);
    if ("error" in creds) {
      res.status(400).json({ error: creds.error, minPasswordLength: MIN_PASSWORD_LENGTH });
      return;
    }

    try {
      const result = await createUser(creds.email, creds.password);
      // !user-registered
      res.status(201).json(result);
    } catch (err) {
      if ((err as { code?: string }).code === "email_taken") {
        res.status(409).json({ error: "email_taken" });
        return;
      }
      throw err;
    }
  }),
);

authRouter.post(
  "/auth/login",
  asyncHandler(async (req, res) => {
    const creds = readCredentials(req.body);
    if ("error" in creds) {
      // Same generic response as a bad password — don't reveal which field failed.
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }

    const result = await authenticateUser(creds.email, creds.password);
    if (!result) {
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }
    // !user-logged-in
    res.json(result);
  }),
);
