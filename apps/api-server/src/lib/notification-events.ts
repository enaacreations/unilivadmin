import { EventEmitter } from "node:events";

/**
 * In-process pub/sub for live (SSE) notification delivery. notify() / the
 * notifications router emit here when an in-app row is created; the SSE handler
 * (GET /notifications/stream) relays to the user's connected browsers.
 *
 * Single-instance only. When the API scales to multiple replicas, back this with
 * Redis pub/sub (publish on `user:<id>`, each instance subscribes).
 */
const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per open SSE connection

export interface LiveNotification {
  id: string;
  title: string;
  body?: string | null;
  type: string;
  link?: string | null;
  createdAt: string;
}

const channel = (userId: string) => `user:${userId}`;

export function emitNotification(userId: string, n: LiveNotification): void {
  bus.emit(channel(userId), n);
}

export function onNotification(userId: string, handler: (n: LiveNotification) => void): () => void {
  const ch = channel(userId);
  bus.on(ch, handler);
  return () => bus.off(ch, handler);
}
