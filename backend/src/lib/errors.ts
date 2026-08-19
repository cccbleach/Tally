import { ZodError } from "zod";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function notFound(code: string, message = "资源不存在"): AppError {
  return new AppError(404, code, message);
}

export function badRequest(code: string, message: string): AppError {
  return new AppError(400, code, message);
}

export function unauthorized(code: string, message: string): AppError {
  return new AppError(401, code, message);
}

export function forbidden(code: string, message: string): AppError {
  return new AppError(403, code, message);
}

export function conflict(code: string, message: string): AppError {
  return new AppError(409, code, message);
}

export function tooManyRequests(code: string, message: string): AppError {
  return new AppError(429, code, message);
}

export function errorHandler(
  err: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  if (err instanceof AppError) {
    return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof ZodError) {
    const msg = err.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ");
    return reply.status(400).send({ error: { code: "VALIDATION", message: msg } });
  }
  if (err.validation) {
    // Fastify 内建 JSON Schema 校验错误
    return reply.status(400).send({ error: { code: "VALIDATION", message: err.message } });
  }
  req.log.error(err);
  return reply.status(500).send({ error: { code: "INTERNAL", message: "服务器内部错误" } });
}
