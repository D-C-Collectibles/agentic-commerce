// Wraps an async Express handler so a rejected promise is forwarded to the error
// middleware instead of hanging the request. Express 4 does not catch async throws on
// its own, so without this a thrown error (bad config, DB/Circle failure) leaves the
// client waiting forever. Applied uniformly to every async route.

import type { NextFunction, Request, RequestHandler, Response } from "express";

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
