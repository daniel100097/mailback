import type { BunRequest } from "bun";
import { z } from "zod";
import { notFound, parseBody, parseId } from "../http";
import { dataKeysForMailbox, getTask, listTasks, startRestore } from "../tasks";

const restoreSchema = z.object({
  mailboxId: z.int(),
  targetAccountId: z.int(),
  targetPath: z.string().trim().min(1),
  keys: z.record(z.string(), z.base64()),
});

export const taskRoutes = {
  /** Wrapped data keys a task over this mailbox needs; the browser unwraps and sends them back. */
  "/api/mailboxes/:id/data-keys": (req: BunRequest<"/api/mailboxes/:id/data-keys">) =>
    Response.json(dataKeysForMailbox(parseId(req.params.id))),

  "/api/tasks": () => Response.json(listTasks()),

  "/api/tasks/restore": {
    async POST(req: Request) {
      const task = await startRestore(await parseBody(req, restoreSchema));
      return Response.json(task, { status: 202 });
    },
  },

  "/api/tasks/:id": (req: BunRequest<"/api/tasks/:id">) => {
    const task = getTask(req.params.id);
    if (!task) throw notFound("Task not found");
    return Response.json(task);
  },
};

