import { WebSocket } from "ws";

/** A late authenticated action may target an agent that has already left. */
export function send(socket, value) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(1013, "Backpressure limit"); return false; }
  try { socket.send(JSON.stringify(value)); return true; } catch { return false; }
}
