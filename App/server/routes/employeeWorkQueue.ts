import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateParams, validateQuery } from "../middleware/validate.js";
import { getEmployeeWorkQueue } from "../services/employeeWorkQueue.js";

/** An employee's current work is visible to every Member, like its work timeline. */
export const employeeWorkQueueRouter = Router({ mergeParams: true });
employeeWorkQueueRouter.use(requireAuth, requireCompanyMember);

employeeWorkQueueRouter.get(
  "/employees/:eid/work-queue",
  validateParams(z.object({ cid: z.string().uuid(), eid: z.string().uuid() }).strict()),
  validateQuery(z.object({}).strict()),
  async (req, res, next) => {
    try {
      const queue = await getEmployeeWorkQueue(req.params.cid, req.params.eid);
      if (!queue) return res.status(404).json({ error: "AI Employee not found" });
      res.json(queue);
    } catch (error) {
      next(error);
    }
  },
);
